/**
 * prompt-polisher — Host half.
 *
 * The Browser half cannot call Host services directly, so this half exposes two
 * exact routes on the deployment's own web server:
 *
 *   GET  /dsh-prompt-polisher/health   — liveness probe for curl / diagnostics
 *   POST /dsh-prompt-polisher/rewrite  — { draft, locale } -> three variants
 *
 * The rewrite runs through the deployment's own LLM service with the model the
 * user already selected (`agentDefaultModel.currentSelection()`), so no extra
 * key, base URL or provider configuration is involved. Responses are strict
 * JSON; the model is asked for one JSON object and a non-JSON answer is folded
 * into a single fallback variant rather than surfacing a 500.
 */

const ROUTE_HEALTH = '/dsh-prompt-polisher/health'
const ROUTE_REWRITE = '/dsh-prompt-polisher/rewrite'

const MAX_BODY_BYTES = 256 * 1024
const MAX_DRAFT_CHARS = 12_000
const MIN_DRAFT_CHARS = 4
const REQUEST_TIMEOUT_MS = 180_000

/** Context mode: how much visible conversation is handed to the model. */
const CONTEXT_TURNS = 4
const CONTEXT_CHAR_BUDGET = 7000
const MAX_CONTEXT_ITEM_CHARS = 2400

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
      return () => {
        offHealth()
        offRewrite()
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
  try {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: 'untrusted origin' })
      return
    }
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
    const startedAt = Date.now()
    const locale = body?.locale === 'en' ? 'en' : 'zh'
    const mode = body?.mode === 'fast' ? 'fast' : 'context'
    const reportedSessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    /* The routing header still needs a non-empty id for some providers; history
     * lookup must use the real Session id only, never the synthetic fallback. */
    const routingSessionId = reportedSessionId === '' ? 'plugin:dsh-prompt-polisher' : reportedSessionId
    const conversation = mode === 'context'
      ? readConversation(ctx, reportedSessionId)
      : { status: 'off', items: [], turns: 0, chars: 0 }
    const context = conversation.status === 'ok'
      ? { status: 'ok', turns: conversation.turns, chars: conversation.chars, label: `已参考最近 ${conversation.turns} 轮` }
      : { status: conversation.status, turns: 0, chars: 0 }
    const outcome = await rewriteDraft(ctx, draft, locale, routingSessionId, { mode, conversation })
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
    const status = Number.isInteger(error?.status) ? error.status : 500
    try {
      sendJson(response, status, { ok: false, error: messageOf(error) })
    } catch {
      response.destroy()
    }
  }
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
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
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
      throw httpError(504, `the model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (finish?.kind === 'aborted') throw httpError(504, 'rewrite was aborted')
  if (finish?.kind === 'error') {
    throw httpError(502, `provider error: ${messageOf(finish.failure)}`)
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
 * @param ctx - plugin context with the sessions service available.
 * @param sessionId - the Session id reported by the composer (a locator only).
 * @returns {{ status: 'ok'|'unavailable'|'empty', items: {role:'user'|'assistant', text:string}[], turns: number, chars: number }}
 */
function readConversation(ctx, sessionId) {
  if (sessionId === '') return { status: 'unavailable', items: [], turns: 0, chars: 0 }
  let session
  try {
    session = ctx.get('sessions')?.get?.(sessionId)
  } catch {
    session = undefined
  }
  if (!session) return { status: 'unavailable', items: [], turns: 0, chars: 0 }
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
  if (turns.length === 0) return { status: 'empty', items: [], turns: 0, chars: 0 }
  const recent = turns.slice(-CONTEXT_TURNS)
  const items = []
  for (const turn of recent) {
    items.push({ role: 'user', text: truncate(turn.prompt, MAX_CONTEXT_ITEM_CHARS) })
    for (const answer of turn.answers) {
      items.push({ role: 'assistant', text: truncate(answer, MAX_CONTEXT_ITEM_CHARS) })
    }
  }
  /* Budget from the newest turn backwards, so the exchange right before the
   * draft survives even when the budget is tight. */
  const kept = []
  let chars = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (kept.length > 0 && chars + item.text.length > CONTEXT_CHAR_BUDGET) break
    kept.push(item)
    chars += item.text.length
  }
  kept.reverse()
  if (!kept.some((item) => item.role === 'user')) return { status: 'empty', items: [], turns: 0, chars: 0 }
  let usedTurns = 0
  for (const item of kept) if (item.role === 'user') usedTurns += 1
  return { status: 'ok', items: kept, turns: usedTurns, chars }
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
 * Turn the model answer into variants. A fenced or chatty answer is repaired
 * where possible; an unparseable one becomes a single variant instead of a 502.
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
    variants.push({ id: 'rewrite', label: '改写', text: cleaned, notes: [] })
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
