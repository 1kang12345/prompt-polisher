/**
 * prompt-polisher — Host half.
 *
 * The Browser half cannot call Host services directly, so this half exposes
 * exact routes on the deployment's own web server:
 *
 *   GET  /dsh-prompt-polisher/health   — liveness probe for curl / diagnostics
 *   POST /dsh-prompt-polisher/rewrite  — { draft, locale, mode, sessionId } -> variants
 *   POST /dsh-prompt-polisher/verify   — { sessionId, version } -> history still current?
 *
 * The rewrite runs through the deployment's own LLM service with the model the
 * user already selected (`agentDefaultModel.currentSelection()`), so no extra
 * key, base URL or provider configuration is involved. Answers must be strict
 * JSON: a truncated or unparseable generation is reported as a retryable error
 * so it can never overwrite the user's draft.
 */

const ROUTE_HEALTH = '/dsh-prompt-polisher/health'
const ROUTE_REWRITE = '/dsh-prompt-polisher/rewrite'
const ROUTE_VERIFY = '/dsh-prompt-polisher/verify'

const MAX_BODY_BYTES = 256 * 1024
const MAX_DRAFT_CHARS = 12_000
const MIN_DRAFT_CHARS = 4
const REQUEST_TIMEOUT_MS = 180_000

/** Context mode: how much visible conversation is handed to the model. */
const CONTEXT_TURNS = 6
const CONTEXT_CHAR_BUDGET = 7000
const MAX_PROMPT_CHARS = 3000
const MAX_ANSWER_CHARS = 2600
const ANSWER_HEAD_CHARS = 520
const ANSWER_TAIL_CHARS = 1000
const ANSWER_PLAN_CHARS = 780

/** Lowest-to-highest reasoning ids, used to clamp the selected effort to what a model offers. */
const REASONING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const SYSTEM_PROMPT = `你是提示词工程师，专门把粗糙的输入改写成可以直接执行的高质量 Prompt。

用户会给出 <draft> 中的原始输入。请在不改变用户真实意图、不添加用户没有提供的私有事实的前提下改写。

硬性要求：
1. 语言跟随原文：中文原文输出中文，英文原文输出英文，不得翻译或混排。
2. 原样保留专有名词、文件路径、命令、代码、数字、版本号和用户明确写出的约束，不得删改或替换成同义词。
3. 不虚构需求、文件、接口、数据或背景。缺失但对执行有影响的信息，写成 [方括号占位符]，例如 [目标文件]、[验收标准]、[运行环境]。
4. 每个版本都要让执行者看清五件事：要做什么、在什么上下文里做、有哪些约束、交付什么、怎样算完成。可以合并小节，但不能退化成一句口号。
5. 生成三个版本，顺序固定：
   - structured：分节结构化版（目标 / 上下文 / 要求 / 交付），信息最全，适合直接发给执行者。
   - spec：工程任务单版（任务、背景、范围、约束、验收标准），适合复杂或高风险任务。
   - concise：精简版，不超过 120 个汉字（英文不超过 60 词），只保留目标与最关键约束。
6. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字，不要前后缀。格式：
{"variants":[{"id":"structured","label":"结构化","text":"..."},{"id":"spec","label":"任务单","text":"..."},{"id":"concise","label":"精简","text":"..."}]}
英文原文时 label 用 Structured / Task brief / Concise。text 中的换行写成 \\n。`;

const CONTEXT_PROMPT = `你是提示词工程师。用户会在同一个对话里写很短的一句跟进，里面有「刚才」「第二种」「那个文件」这类指代。你的任务是把这句话改写成一条可以直接发送的 Prompt，让执行者不需要回看聊天记录也能做对。

输入说明：
- <conversation> 是当前分支上可见的对话，按时间顺序排列，包含用户和助手的正文。
- <draft> 是用户刚刚写下、准备发送的那句话。

改写规则：
1. 先解析指代。把「刚才」「第二种」「那个文件」替换成对话里用户已经确认的具体对象、方案或文件。
2. 当前草稿里明确写出的要求优先级最高；草稿没写的，沿用用户最近一次确认的约束。
3. 助手提出过的方案只是提议，只有用户明确接受后才算已定方案；不要把提议写成事实。
4. 补充会影响执行的关键事实：对象、范围、顺序、输入输出、约束、完成标准。对话里没有的事实不要编，写成 [方括号占位符]。
5. 短跟进保持简短，不要为了结构化而扩写；复杂任务再分「目标 / 上下文 / 要求 / 交付」小节。
6. 语言跟随草稿，保留路径、命令、数值、版本号和用户明确写出的限制。
7. 如果关键指代仍然无法确定，成稿保留原意，并在 notes 里只放一条具体的待确认项，格式「待确认：……」；能确定就不要加。

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释文字。格式：
{"variants":[{"id":"recommended","label":"推荐稿","text":"...","notes":[]}]}
英文草稿时 label 用 Recommended。text 中的换行写成 \\\\n。`;

export function apply(ctx) {
  ctx.inject(['webServer', 'sessions'], (scoped) => {
    scoped.effect(() => {
      const offHealth = scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_HEALTH,
        handler: (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' })
            response.end()
            return
          }
          sendJson(response, 200, { ok: true, route: ROUTE_HEALTH })
        },
      })
      const offRewrite = scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_REWRITE,
        handler: (request, response) => {
          void handleRewrite(scoped, request, response)
        },
      })
      const offVerify = scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_VERIFY,
        handler: (request, response) => {
          void handleVerify(scoped, request, response)
        },
      })
      return () => {
        offHealth()
        offRewrite()
        offVerify()
      }
    }, 'prompt-polisher: rewrite route')
  })
}

/**
 * One rewrite request.
 * @param ctx - the plugin context (webServer already available).
 * @param request - Node's IncomingMessage.
 * @param response - Node's ServerResponse; this handler owns its lifecycle.
 */
async function handleRewrite(ctx, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  if (admitRequest(ctx, request, response) === null) return
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch (error) {
    sendJson(response, 400, { ok: false, error: `bad request body: ${messageOf(error)}` })
    return
  }
  const draft = typeof body?.draft === 'string' ? body.draft.trim() : ''
  if (draft.length < MIN_DRAFT_CHARS) {
    sendJson(response, 400, { ok: false, error: 'draft is too short' })
    return
  }
  if (draft.length > MAX_DRAFT_CHARS) {
    sendJson(response, 413, { ok: false, error: `draft is longer than ${MAX_DRAFT_CHARS} characters` })
    return
  }
  const reportedSessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  /* The browser-supplied id is only a locator. Admission above proves the
   * caller may use this Host; the store lookup below proves the Session exists
   * here, so a forged or stale id cannot address arbitrary history. */
  const session = lookupSession(ctx, reportedSessionId)
  if (reportedSessionId !== '' && session === undefined) {
    sendJson(response, 404, { ok: false, error: 'session not found' })
    return
  }
  const startedAt = Date.now()
  const locale = body?.locale === 'en' ? 'en' : 'zh'
  const mode = body?.mode === 'fast' ? 'fast' : 'context'
  /* Providers such as OpenCode require a routing header; fall back to a
   * synthetic id only for that header, never for history lookup. */
  const routingSessionId = reportedSessionId === '' ? 'plugin:dsh-prompt-polisher' : reportedSessionId
  const conversation = mode === 'context'
    ? readConversation(session)
    : { status: 'off', items: [], turns: 0, chars: 0, truncated: false, version: '' }
  const context = conversation.status === 'ok'
    ? {
        status: 'ok',
        turns: conversation.turns,
        chars: conversation.chars,
        truncated: conversation.truncated === true,
        version: conversation.version,
      }
    : { status: conversation.status, turns: 0, chars: 0, truncated: false, version: conversation.version ?? '' }
  const controller = new AbortController()
  const onClose = () => {
    if (!response.writableEnded) controller.abort()
  }
  response.on('close', onClose)
  try {
    const outcome = await rewriteDraft(ctx, draft, locale, routingSessionId, {
      mode,
      conversation,
      signal: controller.signal,
    })
    if (response.writableEnded || response.destroyed) return
    sendJson(response, 200, {
      ok: true,
      mode,
      context,
      provider: outcome.provider,
      model: outcome.model,
      variants: outcome.variants,
      reasoningEffort: outcome.reasoningEffort,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    if (response.writableEnded || response.destroyed) return
    if (error instanceof Error && error.name === 'AbortError') return
    const status = Number.isInteger(error?.status) ? error.status : 500
    sendJson(response, status, { ok: false, error: messageOf(error) })
  } finally {
    response.off('close', onClose)
  }
}

/**
 * Verify that a panel result still matches the Session's visible history.
 * Rollback and branch switches bump the Session sequence, so a result carrying
 * an older version must not replace the composer draft.
 * @param ctx - plugin context.
 * @param request - Node's IncomingMessage.
 * @param response - Node's ServerResponse.
 */
async function handleVerify(ctx, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' })
    response.end()
    return
  }
  if (admitRequest(ctx, request, response) === null) return
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch (error) {
    sendJson(response, 400, { ok: false, error: `bad request body: ${messageOf(error)}` })
    return
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const expected = typeof body?.version === 'string' ? body.version : ''
  const session = lookupSession(ctx, sessionId)
  if (session === undefined) {
    sendJson(response, 404, { ok: false, error: 'session not found' })
    return
  }
  const current = conversationVersion(session)
  sendJson(response, 200, { ok: true, current, match: versionMatches(session, expected) })
}

/**
 * Run the rewrite through the deployment's LLM.
 * @param ctx - plugin context.
 * @param draft - the user's raw prompt.
 * @param locale - UI locale, used only to keep label language aligned.
 * @param sessionId - the Session the composer belongs to; some providers require it for routing.
 * @param options - { mode, conversation }; context mode uses the visible history.
 * @returns the variants plus the route that produced them.
 */
async function rewriteDraft(ctx, draft, locale, sessionId, options) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw httpError(503, 'LLM service is unavailable in this deployment')
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection === undefined || typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') {
    throw httpError(503, 'No model is selected yet; pick one in the composer first')
  }
  const reasoningEffort = await pickEffort(llm, selection)
  const contextMode = options?.mode === 'context' && options?.conversation?.status === 'ok'
  const system = contextMode ? CONTEXT_PROMPT : SYSTEM_PROMPT
  const user = contextMode
    ? buildContextUser(draft, locale, options.conversation)
    : `<draft>\n${draft}\n</draft>\n\n界面语言：${locale === 'en' ? 'English' : '中文'}`
  /* Text deltas carry an index for the content block they belong to. A long
   * answer can stream several blocks; concatenating in arrival order interleaves
   * the fragments, so bucket per index and join in block order. */
  const blocks = new Map()
  let finish
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  if (options?.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin:dsh-prompt-polisher' },
      }],
      system,
      temperature: 0.3,
      signal: controller.signal,
      ...(sessionId === '' ? {} : { sessionId }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const index = Number.isInteger(chunk.index) ? chunk.index : 0
        blocks.set(index, (blocks.get(index) ?? '') + chunk.text)
      } else if (chunk?.type === 'finish') finish = chunk.reason
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      /* A timeout answers 504; a client disconnect stays an AbortError so the
       * route can drop the response without writing to a dead socket. */
      if (timedOut) throw httpError(504, `the model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`)
      throw error
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (options?.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
  }
  if (finish?.kind === 'aborted') {
    if (timedOut) throw httpError(504, 'the rewrite timed out')
    throw Object.assign(new Error('the rewrite was aborted'), { name: 'AbortError' })
  }
  if (finish?.kind === 'error') {
    throw httpError(502, `provider error: ${messageOf(finish.failure)}`)
  }
  /* A truncated answer is not a usable variant: the JSON is cut mid-object and
   * would otherwise be presented as a half-written prompt. */
  if (finish?.kind === 'max-tokens') {
    throw httpError(502, 'the model output was truncated (max tokens); try again')
  }
  const text = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .join('')
  const variants = parseVariants(text)
  /* Context mode has one recommended answer by design: extra variants would
   * just be rewordings of the same resolved request. */
  return {
    variants: contextMode ? variants.slice(0, 1) : variants,
    provider: selection.provider,
    model: selection.model,
    reasoningEffort,
  }
}

/**
 * Follow the reasoning level selected in the composer. Only when the model
 * advertises no matching level do we fall back to the closest one it offers.
 * The old behaviour forced the lowest level, which made rewrites shallow.
 */
async function pickEffort(llm, selection) {
  const wanted = typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
    ? selection.reasoningEffort
    : 'high'
  if (typeof llm.resolveModelInfo !== 'function') return wanted
  let info
  try {
    info = await llm.resolveModelInfo(selection.provider, selection.model)
  } catch {
    return wanted
  }
  const efforts = (Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id !== '')
  if (efforts.length === 0) return undefined
  if (efforts.includes(wanted)) return wanted
  if (efforts.includes('medium')) return 'medium'
  const wantedRank = REASONING_ORDER.indexOf(wanted)
  let fallback = efforts[0]
  let fallbackRank = -1
  for (const id of efforts) {
    const rank = REASONING_ORDER.indexOf(id)
    if (rank >= 0 && rank <= wantedRank && rank > fallbackRank) {
      fallbackRank = rank
      fallback = id
    }
  }
  return fallback
}

/**
 * Read the branch-visible conversation for a Session. Only user prompts and
 * assistant answer text are used; tool traffic and system-scaffold messages are
 * skipped, and the surface order is the model-visible order. A missing Session,
 * an unreadable store and an empty surface all degrade to draft-only rewriting.
 * @param session - the resolved Session, or undefined when none was named.
 * @returns {{ status: 'ok'|'unavailable'|'empty', items: {role:'user'|'assistant', text:string}[], turns: number, chars: number, truncated: boolean, version: string }}
 */
function readConversation(session) {
  if (!session) return { status: 'unavailable', items: [], turns: 0, chars: 0, truncated: false, version: '' }
  const version = conversationVersion(session)
  let nodes = []
  try {
    nodes = Array.from(session.surface?.nodes ?? [])
  } catch {
    nodes = []
  }
  let events = []
  try {
    events = Array.from(session.snapshotEvents())
  } catch {
    events = []
  }
  const bySeq = new Map()
  for (const event of events) {
    if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
  }
  const turns = []
  let current = null
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (!event) continue
    if (event.type === 'user/message') {
      /* Runtime scaffolding (system-reminder, skill catalog, mnemon snapshot,
       * time samples) is also stored as a user message but is not something the
       * user typed; only source.kind === 'user' is the visible user body. */
      const sourceKind = event.data?.source?.kind
      if (typeof sourceKind === 'string' && sourceKind !== 'user') continue
      const text = contentText(event.data?.content ?? event.data)
      if (text === '' || text.startsWith('<system-reminder>')) continue
      current = { prompt: text, answers: [] }
      turns.push(current)
    } else if (event.type === 'assistant/message' && current !== null) {
      const message = event.data?.message ?? event.data
      const text = contentText(message?.content)
      if (text !== '') current.answers.push(text)
    }
  }
  if (turns.length === 0) return { status: 'empty', items: [], turns: 0, chars: 0, truncated: false, version }
  const recent = turns.slice(-CONTEXT_TURNS)
  const kept = []
  let chars = 0
  let truncated = kept.length < recent.length
  /* Newest turn first: if the budget runs out, older history is what gets
   * dropped. Within a turn the user's question is reserved before its answer,
   * so one long answer can never push out the prompt that asked it. */
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index]
    const room = CONTEXT_CHAR_BUDGET - chars
    if (room < 160) {
      truncated = true
      break
    }
    const prompt = truncate(turn.prompt, MAX_PROMPT_CHARS)
    if (prompt.length < turn.prompt.length) truncated = true
    const keepPrompt = truncate(prompt, Math.max(80, Math.min(prompt.length, Math.floor(room * 0.6))))
    if (keepPrompt.length < prompt.length) truncated = true
    let answer = ''
    const answerRaw = turn.answers.join('\n\n')
    const answerRoom = room - keepPrompt.length - 12
    if (answerRaw !== '' && answerRoom >= 200) {
      const compressed = compressAnswer(answerRaw, Math.min(MAX_ANSWER_CHARS, answerRoom))
      answer = compressed.text
      if (compressed.truncated) truncated = true
    } else if (answerRaw !== '') {
      truncated = true
    }
    kept.unshift({ prompt: keepPrompt, answer })
    chars += keepPrompt.length + answer.length
  }
  if (kept.length === 0) {
    return { status: 'empty', items: [], turns: 0, chars: 0, truncated: true, version }
  }
  if (kept.length < recent.length) truncated = true
  const items = []
  for (const turn of kept) {
    items.push({ role: 'user', text: turn.prompt })
    if (turn.answer !== '') items.push({ role: 'assistant', text: turn.answer })
  }
  return { status: 'ok', items, turns: kept.length, chars, truncated, version }
}

/**
 * Compress one long answer for the context window without losing the two parts
 * that later turns cite: a plan/constraint list and the closing conclusion.
 * @param text - full answer text.
 * @param max - character budget for this answer.
 * @returns the compressed text and whether anything was dropped.
 */
function compressAnswer(text, max) {
  if (text.length <= max) return { text, truncated: false }
  const headLen = Math.min(ANSWER_HEAD_CHARS, Math.floor(max * 0.25))
  const tailLen = Math.min(ANSWER_TAIL_CHARS, Math.floor(max * 0.42))
  const head = text.slice(0, headLen).trim()
  const tail = text.slice(-tailLen).trim()
  const planRoom = Math.max(0, max - headLen - tailLen - 24)
  const plans = extractPlanLines(text).join('\n').slice(0, Math.min(ANSWER_PLAN_CHARS, planRoom)).trim()
  const assembled = [head, plans, tail].filter((part) => part !== '').join('\n…\n')
  if (assembled.length <= max) return { text: assembled, truncated: true }
  const withoutPlans = [head, tail].filter((part) => part !== '').join('\n…\n')
  return { text: withoutPlans.slice(0, max), truncated: true }
}

/**
 * Lines that carry a plan, a constraint or a section header — the parts a later
 * "按第二种" refers to even when they sit at the end of a long answer.
 * @param text - full answer text.
 * @returns the distinct matching lines, in document order.
 */
function extractPlanLines(text) {
  const seen = new Set()
  const lines = []
  let size = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || !isPlanLine(line) || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
    size += line.length + 1
    if (size >= ANSWER_PLAN_CHARS) break
  }
  return lines
}

/**
 * Whether one line looks like a list item, a numbered step, a named option or a
 * labeled section worth keeping when an answer is compressed.
 * @param line - trimmed line.
 * @returns true for plan-like lines.
 */
function isPlanLine(line) {
  return /^(?:[-*•·]|\d+[.)、]|[一二三四五六七八九十]+[、.]|方案\s*[一二三四五六七八九十\d]+|第[一二三四五六七八九十\d]+(?:种|个|步|条|版))/u.test(line)
    || /(?:方案|步骤|验收|交付|约束|目标|范围)[:：]/u.test(line)
}

/**
 * FNV-1a over the first `count` surface node ids.
 * @param nodes - surface node seq ids, in model order.
 * @param count - how many leading nodes to hash.
 * @returns unsigned hash.
 */
function nodeHash(nodes, count) {
  let hash = 2166136261
  for (let index = 0; index < count; index += 1) {
    hash ^= Number(nodes[index]) | 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Fingerprint of the Session's visible history at the start of a request.
 * Verification later compares this as a *prefix*: appending new nodes (the
 * agent keeps working) does not invalidate an answer, while a rollback or
 * branch switch that rewrites the prefix does.
 * @param session - a Session from the sessions service.
 * @returns a short opaque version string.
 */
function conversationVersion(session) {
  let nodes = []
  try {
    nodes = Array.from(session.surface?.nodes ?? [])
  } catch {
    nodes = []
  }
  /* Session.seq advances on every event, including tool traffic that never
   * reaches the visible surface. Versioning on seq would invalidate a result
   * whenever the agent runs a tool; only the surface node list describes the
   * history the next prompt would actually see. */
  return `${nodes.length}:${nodeHash(nodes, nodes.length).toString(36)}`
}

/**
 * Whether the current surface still starts with the recorded nodes.
 * @param session - the Session right now.
 * @param expected - version string produced by conversationVersion.
 * @returns true when nothing before the recorded point changed.
 */
function versionMatches(session, expected) {
  if (expected === '') return true
  const separator = expected.indexOf(':')
  if (separator <= 0) return false
  const count = Number(expected.slice(0, separator))
  if (!Number.isInteger(count) || count < 0) return false
  let nodes = []
  try {
    nodes = Array.from(session.surface?.nodes ?? [])
  } catch {
    return false
  }
  if (nodes.length < count) return false
  return nodeHash(nodes, count).toString(36) === expected.slice(separator + 1)
}

/**
 * Resolve the Session a request names. The id is untrusted input; only a
 * Session that exists in this Host may be read.
 * @param ctx - plugin context.
 * @param sessionId - id supplied by the browser.
 * @returns the Session or undefined.
 */
function lookupSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return ctx.get('sessions')?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Admit one request through the deployment's own connection fence. Browser
 * requests carry the DSH session cookie; non-browser callers are refused.
 * @param ctx - plugin context.
 * @param request - Node's IncomingMessage.
 * @param response - Node's ServerResponse.
 * @returns the peer, or null when a rejection response was already sent.
 */
function admitRequest(ctx, request, response) {
  const connection = ctx.get('connection')
  if (connection === undefined || typeof connection.admit !== 'function') {
    sendJson(response, 503, { ok: false, error: 'connection service is unavailable' })
    return null
  }
  let admission
  try {
    admission = connection.admit(request)
  } catch {
    admission = { rejection: 401 }
  }
  if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
    const status = admission.rejection === 403 ? 403 : 401
    sendJson(response, status, { ok: false, error: status === 403 ? 'forbidden' : 'authentication required' })
    return null
  }
  return admission?.peer ?? {}
}

/**
 * Plain text of a Message content value: a string, or an array of blocks.
 * @param content - message content.
 * @returns the concatenated text, trimmed.
 */
function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function buildContextUser(draft, locale, conversation) {
  const lines = ['<conversation>']
  for (const item of conversation.items) {
    lines.push(`${item.role === 'user' ? '用户' : '助手'}：${item.text}`)
  }
  lines.push('</conversation>', '', '<draft>', draft, '</draft>', '', `界面语言：${locale === 'en' ? 'English' : '中文'}`)
  return lines.join('\n')
}

/**
 * Turn the model answer into variants. Fenced or chatty answers are repaired
 * where possible; an unparseable answer is a failed generation (502) rather
 * than a raw JSON blob shown as if it were a prompt.
 */
function parseVariants(raw) {
  const cleaned = stripFence(raw).trim()
  let data
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      data = JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      data = undefined
    }
  }
  const list = Array.isArray(data?.variants) ? data.variants : Array.isArray(data) ? data : []
  const variants = []
  for (const item of list) {
    const text = typeof item === 'string' ? item : item?.text
    if (typeof text !== 'string' || text.trim() === '') continue
    const id = uniqueId(sanitizeId(typeof item === 'object' ? item?.id : undefined, variants.length), variants)
    variants.push({
      id,
      label: typeof item?.label === 'string' && item.label.trim() !== '' ? item.label.trim() : defaultLabel(id, variants.length),
      text: text.trim(),
      notes: Array.isArray(item?.notes) ? item.notes.filter(note => typeof note === 'string' && note.trim() !== '').map(note => note.trim()).slice(0, 6) : [],
    })
    if (variants.length === 3) break
  }
  if (variants.length === 0) {
    if (cleaned === '') throw httpError(502, 'the model returned an empty answer')
    /* A half-written or non-JSON answer is a failed generation, not a prompt:
     * surfacing its raw text as a variant would hand the user broken JSON. */
    throw httpError(502, 'the model returned invalid JSON; try again')
  }
  return variants
}

function stripFence(text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed.replace(/^```[a-zA-Z]*\s*/u, '').replace(/```$/u, '')
}

function sanitizeId(value, index) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (/^[a-z][a-z0-9-]{0,23}$/u.test(candidate)) return candidate
  return ['structured', 'spec', 'concise'][index] ?? `variant-${index + 1}`
}

function uniqueId(id, variants) {
  if (!variants.some(variant => variant.id === id)) return id
  let suffix = 2
  while (variants.some(variant => variant.id === `${id}-${suffix}`)) suffix += 1
  return `${id}-${suffix}`
}

function defaultLabel(id, index) {
  if (id === 'structured') return '结构化'
  if (id === 'spec') return '任务单'
  if (id === 'concise') return '精简'
  return ['结构化', '任务单', '精简'][index] ?? '改写'
}

/**
 * Read a bounded request body as UTF-8 text.
 * @param request - Node's IncomingMessage.
 * @returns the decoded body; rejects when the body exceeds MAX_BODY_BYTES.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'request body is too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Same-origin gate: a browser request carries an Origin header; a missing one
 * is a local tool (curl) and is accepted.
 * @param request - Node's IncomingMessage.
 * @returns true when the request may proceed.
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function sendJson(response, status, data) {
  const payload = JSON.stringify(data)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
