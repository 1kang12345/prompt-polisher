window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-polisher',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/dsh-prompt-polisher/rewrite'
    const VERIFY_ROUTE = '/dsh-prompt-polisher/verify'
    const AUTO_KEY = 'dsh-prompt-polisher.auto'
    const AUTO_DELAY_MS = 1200
    const MIN_DRAFT_CHARS = 4

    const STRINGS = {
      zh: {
        trigger: '优化提示词',
        title: '提示词优化',
        subtitle: '粗糙草稿 → 可执行的 Prompt',
        close: '关闭',
        rewrite: '改写',
        contextMode: '结合当前对话',
        fastMode: '快速改写',
        rewriting: '正在改写…',
        contextStatus: (n, truncated) => truncated ? `已参考最近 ${n} 轮（部分截断）` : `已参考最近 ${n} 轮`,
        contextEmpty: '当前仅依据草稿',
        contextUnavailable: '会话不可读取，已退回纯草稿',
        staleVersion: '对话已经变化（可能被回滚或切换了分支），下面是旧版本的结果。',
        verifyFailed: '无法确认对话版本，已阻止替换。',
        refsBlocked: '输入框含 @ 引用，整段替换会丢失引用，已禁用替换；可以复制后手动粘贴。',
        applying: '正在校验…',
        empty: '输入框里还没有内容。先写一句想做的事，再点改写。',
        tooShort: '至少写 4 个字符再改写。',
        failed: '改写失败',
        retry: '重试',
        stale: '输入框的内容已经变了，下面是旧版本的结果。',
        staleAction: '按当前内容重新改写',
        diff: '差异',
        plain: '全文',
        apply: '替换输入框',
        applied: '已替换输入框，可继续编辑或发送。',
        copy: '复制',
        copied: '已复制到剪贴板。',
        copyFailed: '复制失败，请手动选择文本。',
        auto: '停顿后快速改写',
        model: '模型',
        took: '耗时',
        notes: '改写说明',
        confirm: '待确认',
        charCount: (n) => `${n} 字`,
        variant: '版本',
      },
      en: {
        trigger: 'Polish prompt',
        title: 'Prompt polisher',
        subtitle: 'Rough draft → executable prompt',
        close: 'Close',
        rewrite: 'Rewrite',
        contextMode: 'With conversation',
        fastMode: 'Quick rewrite',
        rewriting: 'Rewriting…',
        contextStatus: (n, truncated) => truncated ? `Using the last ${n} turn${n === 1 ? '' : 's'} (partly trimmed)` : `Using the last ${n} turn${n === 1 ? '' : 's'}`,
        contextEmpty: 'Draft only',
        contextUnavailable: 'Conversation unavailable — draft only',
        staleVersion: 'The conversation changed (rollback or branch switch); this result is from an older version.',
        verifyFailed: 'Could not confirm the conversation version; replace is blocked.',
        refsBlocked: 'The composer contains @ references; replacing the whole draft would drop them, so replace is disabled. Copy instead.',
        applying: 'Checking…',
        empty: 'The composer is empty. Write one line about what you want, then rewrite.',
        tooShort: 'Write at least 4 characters first.',
        failed: 'Rewrite failed',
        retry: 'Retry',
        stale: 'The composer changed; this result is from an older draft.',
        staleAction: 'Rewrite the current draft',
        diff: 'Diff',
        plain: 'Full text',
        apply: 'Replace draft',
        applied: 'Draft replaced — keep editing or send it.',
        copy: 'Copy',
        copied: 'Copied to clipboard.',
        copyFailed: 'Copy failed; select the text manually.',
        auto: 'Quick rewrite after a pause',
        model: 'Model',
        took: 'Took',
        notes: 'Notes',
        confirm: 'To confirm',
        charCount: (n) => `${n} chars`,
        variant: 'Variant',
      },
    }

    /* ---------------------------------------------------------------- diff */

    const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff'
    const TOKEN_RE = new RegExp(`(\\s+|([${CJK}])|([^\\s${CJK}]+))`, 'gu')

    /**
     * Split text into diff tokens: one CJK character, one whitespace run, or one
     * run of Latin/punctuation. CJK has no word boundaries, so characters are
     * the smallest useful unit there.
     * @param text - plain text.
     * @returns tokens in reading order.
     */
    function tokenize(text) {
      const tokens = []
      TOKEN_RE.lastIndex = 0
      let match
      while ((match = TOKEN_RE.exec(text)) !== null) {
        if (match[0] !== '') tokens.push(match[0])
      }
      return tokens
    }

    /**
     * Longest-common-subsequence table for two token arrays.
     * @returns a flat Int32Array of (a.length + 1) * (b.length + 1) cells.
     */
    function lcsTable(a, b) {
      const width = b.length + 1
      const table = new Int32Array((a.length + 1) * width)
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i * width + j] = a[i] === b[j]
            ? table[(i + 1) * width + (j + 1)] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)])
        }
      }
      return table
    }

    /**
     * Token diff of two texts, using common prefix/suffix trimming and a size
     * guard so a huge draft cannot allocate a giant table.
     * @returns compacted runs `{ kind: 'same' | 'del' | 'ins', text }`.
     */
    function diffRuns(before, after) {
      const a = tokenize(before)
      const b = tokenize(after)
      let start = 0
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1
      let endA = a.length
      let endB = b.length
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1
        endB -= 1
      }
      const midA = a.slice(start, endA)
      const midB = b.slice(start, endB)
      let middle
      if (midA.length === 0 || midB.length === 0) {
        middle = [
          ...midA.map((text) => ({ kind: 'del', text })),
          ...midB.map((text) => ({ kind: 'ins', text })),
        ]
      } else if (midA.length * midB.length > 200000) {
        middle = [
          ...midA.map((text) => ({ kind: 'del', text })),
          ...midB.map((text) => ({ kind: 'ins', text })),
        ]
      } else {
        const width = midB.length + 1
        const table = lcsTable(midA, midB)
        const steps = []
        let i = 0
        let j = 0
        while (i < midA.length && j < midB.length) {
          if (midA[i] === midB[j]) {
            steps.push({ kind: 'same', text: midA[i] })
            i += 1
            j += 1
          } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
            steps.push({ kind: 'del', text: midA[i] })
            i += 1
          } else {
            steps.push({ kind: 'ins', text: midB[j] })
            j += 1
          }
        }
        while (i < midA.length) {
          steps.push({ kind: 'del', text: midA[i] })
          i += 1
        }
        while (j < midB.length) {
          steps.push({ kind: 'ins', text: midB[j] })
          j += 1
        }
        middle = steps
      }
      const runs = []
      const push = (kind, text) => {
        const last = runs[runs.length - 1]
        if (last && last.kind === kind) last.text += text
        else runs.push({ kind, text })
      }
      for (const token of a.slice(0, start)) push('same', token)
      for (const step of middle) push(step.kind, step.text)
      for (const token of a.slice(endA)) push('same', token)
      return runs
    }

    /* -------------------------------------------------------------- pieces */

    function Sparkle(props) {
      const size = props && props.size ? props.size : 15
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.25,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      },
        h('path', {
          d: 'M6.9 2.7 8.15 6.05 11.5 7.3 8.15 8.55 6.9 11.9 5.65 8.55 2.3 7.3 5.65 6.05Z',
        }),
        h('path', { d: 'M12.55 2.5v2.2M11.45 3.6h2.2' }),
        h('path', { d: 'M12.7 10.9v1.6M11.9 11.7h1.6', opacity: 0.55 }),
      )
    }

    function readAuto() {
      try {
        return window.localStorage.getItem(AUTO_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeAuto(value) {
      try {
        window.localStorage.setItem(AUTO_KEY, value ? '1' : '0')
      } catch {
        /* private mode or a locked-down storage — the toggle still works for this session */
      }
    }

    /**
     * Re-anchor inline reference chips into rewritten text. Chips have no
     * textual identity beyond their clipboard projection, so a rewrite only
     * preserves them when every projection still appears in the new text.
     * @param text - rewritten draft text.
     * @param occurrences - chips from the composer's InputState.
     * @returns reference list, or null when at least one chip would be lost.
     */
    function mapReferences(text, occurrences) {
      const references = []
      let from = 0
      for (const occurrence of occurrences) {
        const token = occurrence && typeof occurrence.clipboardText === 'string' ? occurrence.clipboardText : ''
        if (token === '') return null
        /* Models often drop the leading "@" or keep it; accept both spellings
         * and anchor the chip over the widest span that is actually present. */
        const bare = token.startsWith('@') ? token.slice(1) : token
        let at = text.indexOf(token, from)
        let length = token.length
        if (at < 0 && bare !== token) {
          at = text.indexOf(bare, from)
          if (at >= 0) {
            if (at > 0 && text[at - 1] === '@') {
              at -= 1
              length = token.length
            } else {
              length = bare.length
            }
          }
        }
        if (at < 0) return null
        const reference = {
          source: occurrence.source,
          ref: occurrence.ref,
          offset: at,
          length,
          label: occurrence.label,
          clipboardText: token,
        }
        if (occurrence.appearance !== undefined) reference.appearance = occurrence.appearance
        references.push(reference)
        from = at + length
      }
      return references
    }

    /**
     * Ask the Host whether a result still matches the Session's visible
     * history. A failure is treated as "not current" so replace stays blocked.
     * @param sessionId - the Session the result was computed for.
     * @param version - conversation version returned with that result.
     * @returns whether the result may still be applied.
     */
    async function verifyVersion(sessionId, version) {
      try {
        const response = await fetch(VERIFY_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, version }),
          cache: 'no-store',
          credentials: 'same-origin',
        })
        let data = null
        try { data = await response.json() } catch { data = null }
        if (!response.ok) return false
        return data && data.ok === true && data.match === true
      } catch {
        return false
      }
    }

    /* --------------------------------------------------------------- panel */

    function Polisher(props) {
      const draft = props.useInput((state) => state.draft) || ''
      const occurrences = props.useInput((state) => state.occurrences) || []
      const locale = props.getLocale ? props.getLocale() : 'zh'
      const t = STRINGS[locale] || STRINGS.zh

      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [applying, setApplying] = React.useState(false)
      const [error, setError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [active, setActive] = React.useState(0)
      const [view, setView] = React.useState('diff')
      const [auto, setAuto] = React.useState(readAuto)
      const [toast, setToast] = React.useState('')
      const [hint, setHint] = React.useState('')
      const [mode, setMode] = React.useState('context')
      const [versionStale, setVersionStale] = React.useState(false)

      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [anchor, setAnchor] = React.useState(null)
      const abortRef = React.useRef(null)
      const lastAutoRef = React.useRef('')
      const toastTimerRef = React.useRef(null)
      const requestRef = React.useRef(0)
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const sessionRef = React.useRef(props.sessionId)
      sessionRef.current = props.sessionId

      const showToast = React.useCallback((text) => {
        setToast(text)
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = window.setTimeout(() => setToast(''), 2600)
      }, [])

      React.useEffect(() => () => {
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
        if (abortRef.current) abortRef.current.abort()
      }, [])

      const run = React.useCallback(async (text, runMode) => {
        const nextMode = runMode === 'fast' ? 'fast' : 'context'
        const trimmed = typeof text === 'string' ? text.trim() : ''
        if (trimmed.length < MIN_DRAFT_CHARS) {
          setHint(t.tooShort)
          return
        }
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        requestRef.current += 1
        const requestId = requestRef.current
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        setMode(nextMode)
        setBusy(true)
        setApplying(false)
        setVersionStale(false)
        setError('')
        setHint('')
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ draft: trimmed, locale, sessionId, mode: nextMode }),
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          })
          const raw = await response.text()
          let data = {}
          try {
            data = raw === '' ? {} : JSON.parse(raw)
          } catch {
            throw new Error(`HTTP ${response.status}`)
          }
          if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`)
          const variants = Array.isArray(data.variants)
            ? data.variants.filter((variant) => variant && typeof variant.text === 'string' && variant.text.trim() !== '')
            : []
          if (variants.length === 0) throw new Error(t.failed)
          /* A late answer from an aborted or superseded request must not touch
           * the result that belongs to the newest draft/session/mode. */
          if (requestId !== requestRef.current) return
          setResult({
            requestId,
            sessionId,
            mode: nextMode,
            draft: trimmed,
            variants,
            context: data.context && typeof data.context === 'object' ? data.context : null,
            version: typeof data.context?.version === 'string' ? data.context.version : '',
            provider: typeof data.provider === 'string' ? data.provider : '',
            model: typeof data.model === 'string' ? data.model : '',
            elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : 0,
          })
          setVersionStale(false)
          setActive(0)
          setView('diff')
        } catch (caught) {
          if (caught && caught.name === 'AbortError') return
          if (requestId !== requestRef.current) return
          setError(caught && caught.message ? caught.message : String(caught))
        } finally {
          if (abortRef.current === controller) abortRef.current = null
          if (requestId === requestRef.current) setBusy(false)
        }
      }, [locale, t, props.sessionId])

      const trimmedDraft = draft.trim()
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const stale = result !== null && (
        result.draft !== trimmedDraft ||
        result.sessionId !== sessionId ||
        result.mode !== mode ||
        versionStale
      )

      /* Switching Session or branch invalidates whatever the panel is holding:
       * the old request is aborted and its result can no longer be applied. */
      React.useEffect(() => {
        requestRef.current += 1
        if (abortRef.current) {
          abortRef.current.abort()
          abortRef.current = null
        }
        setResult(null)
        setError('')
        setBusy(false)
        setApplying(false)
        setVersionStale(false)
      }, [sessionId])

      const toggle = () => {
        const next = !open
        setOpen(next)
        setToast('')
        setHint('')
        if (next && !busy && (!result || stale)) run(draft, mode)
      }

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      React.useEffect(() => {
        if (!open || !auto || busy) return undefined
        if (trimmedDraft.length < MIN_DRAFT_CHARS) return undefined
        if (result && result.draft === trimmedDraft) return undefined
        if (lastAutoRef.current === trimmedDraft) return undefined
        const timer = window.setTimeout(() => {
          lastAutoRef.current = trimmedDraft
          run(draft, 'fast')
        }, AUTO_DELAY_MS)
        return () => window.clearTimeout(timer)
      }, [open, auto, busy, draft, trimmedDraft, result, run])

      React.useLayoutEffect(() => {
        if (!open) {
          setAnchor((prev) => (prev === null ? prev : null))
          return undefined
        }
        const place = () => {
          const root = rootRef.current
          const el = panelRef.current
          if (!root || !el) return
          const card = root.closest('[class*="card"]')
          const anchorEl = card || root
          const box = anchorEl.getBoundingClientRect()
          const width = Math.max(240, Math.min(560, box.width - 16))
          if (Math.abs((el.offsetWidth || 0) - width) > 1) el.style.width = `${width}px`
          /* Keep clear of the window chrome; the composer card can grow very tall. */
          const topInset = 44
          const spaceAbove = Math.max(0, box.top - topInset - 10)
          const spaceBelow = Math.max(0, window.innerHeight - box.bottom - 10)
          const natural = el.offsetHeight || 0
          let preferAbove = spaceAbove >= natural || spaceAbove >= spaceBelow
          if (preferAbove && spaceAbove < 140) preferAbove = spaceBelow > spaceAbove
          const available = Math.max(120, Math.min(560, preferAbove ? spaceAbove : spaceBelow))
          el.style.maxHeight = `${available}px`
          const height = el.offsetHeight || natural
          if (height === 0) return
          const borderLeft = card ? (parseFloat(getComputedStyle(card).borderLeftWidth) || 0) : 0
          const borderTop = card ? (parseFloat(getComputedStyle(card).borderTopWidth) || 0) : 0
          const borderRight = card ? (parseFloat(getComputedStyle(card).borderRightWidth) || 0) : 0
          const borderBottom = card ? (parseFloat(getComputedStyle(card).borderBottomWidth) || 0) : 0
          const innerLeft = box.left + borderLeft
          const innerWidth = box.width - borderLeft - borderRight
          const innerHeight = box.height - borderTop - borderBottom
          const rootRect = root.getBoundingClientRect()
          const left = Math.max(0, Math.min(rootRect.left - innerLeft, innerWidth - width - 8))
          const top = preferAbove ? -(height + 10) : innerHeight + 10
          setAnchor((prev) => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
        }
        place()
        window.addEventListener('resize', place)
        let observer = null
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(place)
          if (panelRef.current) observer.observe(panelRef.current)
          const root = rootRef.current
          const card = root ? root.closest('[class*="card"]') : null
          if (card) observer.observe(card)
        }
        return () => {
          window.removeEventListener('resize', place)
          if (observer) observer.disconnect()
        }
      }, [open, busy, error, result, view, active, stale])

      /**
       * Write a draft while keeping its inline chips. The public InputActions
       * only accept plain text, so resolve the SessionInput facade and hand it
       * a DraftSnapshot. Any failure falls back to blocking the replace.
       */
      const writeWithReferences = (text, references) => {
        try {
          const scope = props.api?.sessions?.scope?.(sessionId)
          const conversation = scope?.get?.('conversation')
          const input = conversation?.input?.for?.(scope)
          if (!input || typeof input.setDraft !== 'function') return false
          input.setDraft({ text, references })
          if (typeof props.inputActions.persistDraft === 'function') props.inputActions.persistDraft()
          return true
        } catch {
          return false
        }
      }

      const applyVariant = async () => {
        const current = result ? result.variants[Math.min(active, result.variants.length - 1)] : null
        if (!current || stale || busy || applying) return
        setApplying(true)
        setHint('')
        try {
          /* Same-session rollback can leave draft, session and mode unchanged,
           * so the Host's conversation version is the deciding guard. */
          if (result.version !== '') {
            const stillCurrent = await verifyVersion(result.sessionId, result.version)
            if (!stillCurrent) {
              setVersionStale(true)
              setHint(t.verifyFailed)
              return
            }
          }
          if (requestRef.current !== result.requestId || draftRef.current.trim() !== result.draft || (sessionRef.current || '') !== result.sessionId) {
            setHint(t.stale)
            return
          }
          let references = null
          if (occurrences.length > 0) {
            references = mapReferences(current.text, occurrences)
            if (references === null) {
              setHint(t.refsBlocked)
              return
            }
          }
          if (references === null) {
            props.inputActions.setDraft(current.text)
            if (typeof props.inputActions.persistDraft === 'function') props.inputActions.persistDraft()
          } else if (!writeWithReferences(current.text, references)) {
            setHint(t.refsBlocked)
            return
          }
          showToast(t.applied)
          setOpen(false)
        } catch {
          setHint(t.failed)
        } finally {
          setApplying(false)
        }
      }

      const copyVariant = async () => {
        const variant = result && result.variants[active]
        if (!variant) return
        try {
          await navigator.clipboard.writeText(variant.text)
          showToast(t.copied)
        } catch {
          showToast(t.copyFailed)
        }
      }

      const variant = result ? result.variants[Math.min(active, result.variants.length - 1)] : null
      const refsLost = variant !== null && occurrences.length > 0 && mapReferences(variant.text, occurrences) === null

      const trigger = h('button', {
        type: 'button',
        className: `pp-trigger${open ? ' is-open' : ''}`,
        title: t.trigger,
        'aria-label': t.trigger,
        'aria-expanded': open,
        onClick: toggle,
      }, h(Sparkle, { size: 16 }))

      if (!open) {
        return h('div', { className: 'pp-root', ref: rootRef }, trigger, h('style', null, CSS))
      }

      const contextLabel = result === null
        ? ''
        : result.context?.status === 'ok'
          ? t.contextStatus(result.context.turns, result.context.truncated === true)
          : result.context?.status === 'unavailable'
            ? t.contextUnavailable
            : t.contextEmpty

      const header = h('div', { className: 'pp-head' },
        h('div', { className: 'pp-head-text' },
          h('span', { className: 'pp-title' }, h('span', { className: 'pp-spark' }, h(Sparkle, { size: 13 })), t.title),
          h('span', { className: 'pp-sub' }, t.subtitle),
          contextLabel !== '' && h('span', { className: 'pp-context' }, contextLabel),
        ),
        h('div', { className: 'pp-head-right' },
          result && h('span', { className: 'pp-meta' },
            `${result.model || t.model}${result.elapsedMs ? ` · ${(result.elapsedMs / 1000).toFixed(1)}s` : ''}`),
          h('button', {
            type: 'button',
            className: 'pp-icon-btn',
            title: t.close,
            'aria-label': t.close,
            onClick: () => setOpen(false),
          }, '×'),
        ),
      )

      let body
      if (busy) {
        body = h('div', { className: 'pp-loading' },
          h('div', { className: 'pp-skeleton' }),
          h('div', { className: 'pp-skeleton pp-skeleton-short' }),
          h('div', { className: 'pp-skeleton pp-skeleton-mid' }),
          h('div', { className: 'pp-loading-text' }, t.rewriting),
        )
      } else if (error !== '') {
        body = h('div', { className: 'pp-error' },
          h('div', { className: 'pp-error-title' }, t.failed),
          h('div', { className: 'pp-error-body' }, error),
          h('button', { type: 'button', className: 'pp-btn', onClick: () => run(draft, mode) }, t.retry),
        )
      } else if (variant) {
        const tabs = result.variants.map((item, index) => h('button', {
          type: 'button',
          key: item.id || String(index),
          className: `pp-tab${index === active ? ' is-active' : ''}`,
          onClick: () => setActive(index),
        }, item.label || `${t.variant} ${index + 1}`))
        const segments = view === 'diff' ? diffRuns(result.draft, variant.text) : null
        const notes = Array.isArray(variant.notes) ? variant.notes : []
        const confirms = notes.filter((note) => /^待确认[:：]/u.test(note))
        const rest = notes.filter((note) => !/^待确认[:：]/u.test(note))
        body = h('div', { className: 'pp-result' },
          stale && h('div', { className: 'pp-stale' },
            h('span', null, versionStale ? t.staleVersion : t.stale),
            h('button', { type: 'button', className: 'pp-link', onClick: () => run(draft, mode) }, t.staleAction),
          ),
          refsLost && h('div', { className: 'pp-refs' }, t.refsBlocked),
          h('div', { className: 'pp-tabs-row' },
            result.variants.length > 1 && h('div', { className: 'pp-tabs' }, tabs),
            h('div', { className: 'pp-views' },
              h('button', {
                type: 'button',
                className: `pp-view${view === 'diff' ? ' is-active' : ''}`,
                onClick: () => setView('diff'),
              }, t.diff),
              h('button', {
                type: 'button',
                className: `pp-view${view === 'plain' ? ' is-active' : ''}`,
                onClick: () => setView('plain'),
              }, t.plain),
            ),
          ),
          view === 'diff'
            ? h('pre', { className: 'pp-diff' }, segments.map((segment, index) => segment.kind === 'same'
              ? h('span', { key: index }, segment.text)
              : h('span', { key: index, className: segment.kind === 'del' ? 'pp-del' : 'pp-ins' }, segment.text)))
            : h('pre', { className: 'pp-text' }, variant.text),
          confirms.length > 0 && h('div', { className: 'pp-notes pp-notes-confirm' },
            h('div', { className: 'pp-notes-title' }, t.confirm),
            h('ul', null, confirms.map((note, index) => h('li', { key: index }, note.replace(/^待确认[:：]\\s*/u, ''))))),
          rest.length > 0 && h('div', { className: 'pp-notes' },
            h('div', { className: 'pp-notes-title' }, t.notes),
            h('ul', null, rest.map((note, index) => h('li', { key: index }, note)))),
        )
      } else {
        body = h('div', { className: 'pp-empty' },
          h('div', null, draft.trim() === '' ? t.empty : t.tooShort),
          h('div', { className: 'pp-empty-actions' },
            h('button', { type: 'button', className: 'pp-btn pp-btn-primary', onClick: () => run(draft, 'context') }, t.contextMode),
            h('button', { type: 'button', className: 'pp-btn', onClick: () => run(draft, 'fast') }, t.fastMode),
          ),
        )
      }

      const footer = h('div', { className: 'pp-foot' },
        h('label', { className: 'pp-auto' },
          h('input', {
            type: 'checkbox',
            checked: auto,
            onChange: (event) => {
              const next = event.target.checked
              setAuto(next)
              writeAuto(next)
            },
          }),
          h('span', null, t.auto),
        ),
        h('div', { className: 'pp-actions' },
          hint !== '' && h('span', { className: 'pp-hint' }, hint),
          toast !== '' && h('span', { className: 'pp-toast' }, toast),
          h('button', {
            type: 'button',
            className: 'pp-btn',
            disabled: !variant,
            onClick: copyVariant,
          }, t.copy),
          h('button', {
            type: 'button',
            className: 'pp-btn pp-btn-primary',
            disabled: !variant || stale || busy || applying || refsLost,
            title: refsLost ? t.refsBlocked : undefined,
            onClick: applyVariant,
          }, applying ? t.applying : t.apply),
        ),
      )

      const pickMode = (next) => {
        setMode(next)
        if (trimmedDraft.length >= MIN_DRAFT_CHARS) run(draft, next)
        else setHint(t.tooShort)
      }

      const modeRow = h('div', { className: 'pp-modes' },
        h('button', {
          type: 'button',
          className: `pp-mode${mode === 'context' ? ' is-active' : ''}`,
          disabled: busy,
          onClick: () => pickMode('context'),
        }, t.contextMode),
        h('button', {
          type: 'button',
          className: `pp-mode${mode === 'fast' ? ' is-active' : ''}`,
          disabled: busy,
          onClick: () => pickMode('fast'),
        }, t.fastMode),
      )

      const panelStyle = anchor === null
        ? { left: '0px', top: '0px', visibility: 'hidden' }
        : { left: `${anchor.left}px`, top: `${anchor.top}px` }

      const panel = h('div', {
        className: 'pp-panel',
        ref: panelRef,
        style: panelStyle,
        role: 'dialog',
        'aria-label': t.title,
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      }, header, h('div', { className: 'pp-body' }, modeRow, body), footer)

      return h('div', { className: 'pp-root', ref: rootRef }, trigger, h('style', null, CSS), panel)
    }

    /* ---------------------------------------------------------------- style */

    const CSS = `
.pp-root { display: inline-flex; align-items: center; }
.pp-trigger {
  width: 30px; height: 30px; margin: -1px 0; padding: 0;
  border: 1px solid transparent; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--dsw-alias-label-dimmed, #8a9099);
  cursor: pointer; outline: none;
  transition: color .16s ease, background .16s ease, border-color .16s ease, box-shadow .16s ease, transform .12s ease;
}
.pp-trigger svg { display: block; }
.pp-trigger:hover {
  color: var(--dsw-alias-brand-primary, #4f6bff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 9%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 22%, transparent);
}
.pp-trigger:active {
  transform: scale(.94);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 15%, transparent);
}
.pp-trigger:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 40%, transparent);
}
.pp-trigger.is-open {
  color: var(--dsw-alias-brand-primary, #4f6bff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 13%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 32%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 18%, transparent);
}
.pp-panel {
  position: absolute; left: 0; top: 0;
  width: min(560px, calc(100vw - 80px)); max-height: min(64vh, 560px);
  display: flex; flex-direction: column; z-index: 60;
  background: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label, #1f2329);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,.1)) 85%, transparent);
  border-radius: 16px;
  box-shadow:
    0 24px 48px -16px rgba(0,0,0,.5),
    0 8px 20px -8px rgba(0,0,0,.32),
    inset 0 1px 0 color-mix(in srgb, #ffffff 8%, transparent);
  overflow: hidden; font-size: 12px; line-height: 1.6; text-align: left;
  animation: pp-in .14s ease-out;
}
@keyframes pp-in { from { opacity: 0; transform: translateY(4px) scale(.992); } to { opacity: 1; transform: none; } }
.pp-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 12px 14px 10px;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 9%, transparent),
    transparent);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
}
.pp-head-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pp-title { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; letter-spacing: .01em; color: var(--dsw-alias-label, #1f2329); }
.pp-spark { display: inline-flex; align-items: center; color: var(--dsw-alias-brand-primary, #4f6bff); line-height: 1; }
.pp-sub { color: var(--dsw-alias-label-caption, #9aa0a8); font-size: 11px; }
.pp-head-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.pp-meta { color: var(--dsw-alias-label-caption, #9aa0a8); font-size: 11px; white-space: nowrap; }
.pp-icon-btn { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-dimmed, #8a9099); font-size: 16px; line-height: 1; cursor: pointer; }
.pp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label, #1f2329); }
.pp-loading { padding: 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.pp-skeleton { height: 9px; border-radius: 5px; background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2, #eef0f3) 25%, var(--dsw-alias-bg-layer-3, #f6f7f9) 50%, var(--dsw-alias-bg-layer-2, #eef0f3) 75%); background-size: 200% 100%; animation: pp-pulse 1.3s ease-in-out infinite; }
.pp-skeleton-short { width: 62%; }
.pp-skeleton-mid { width: 80%; }
@keyframes pp-pulse { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.pp-loading-text { color: var(--dsw-alias-label-caption, #9aa0a8); }
.pp-error { margin: 12px; padding: 10px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-danger, #d93026) 8%, transparent); display: flex; flex-direction: column; gap: 6px; }
.pp-error-title { font-weight: 600; color: var(--dsw-alias-danger, #d93026); }
.pp-error-body { color: var(--dsw-alias-label-dimmed, #8a9099); word-break: break-word; }
.pp-result { display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.pp-stale { margin: 8px 12px 0; padding: 6px 8px; border-radius: 7px; background: color-mix(in srgb, var(--dsw-alias-accent, #e6a23c) 14%, transparent); color: var(--dsw-alias-label-dimmed, #8a9099); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pp-refs { margin: 8px 12px 0; padding: 6px 8px; border-radius: 7px; background: color-mix(in srgb, var(--dsw-alias-danger, #e06c75) 10%, transparent); color: var(--dsw-alias-label-dimmed, #8a9099); font-size: 11px; line-height: 1.45; }
.pp-tabs-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px 0; }
.pp-tabs { display: flex; gap: 2px; flex-wrap: wrap; padding: 2px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #eef0f3) 70%, transparent); }
.pp-tab { border: 0; background: transparent; color: var(--dsw-alias-label-dimmed, #8a9099); padding: 4px 10px; border-radius: 7px; font-size: 11px; cursor: pointer; transition: background .12s, color .12s; }
.pp-tab:hover { color: var(--dsw-alias-label, #1f2329); }
.pp-tab.is-active {
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label, #1f2329); font-weight: 600;
  box-shadow: 0 1px 2px rgba(0,0,0,.16), inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-border-l1, rgba(0,0,0,.1)) 70%, transparent);
}
.pp-views { display: flex; gap: 2px; flex-shrink: 0; padding: 2px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #eef0f3) 55%, transparent); }
.pp-view { border: 0; background: transparent; color: var(--dsw-alias-label-caption, #9aa0a8); padding: 3px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; }
.pp-view.is-active { color: var(--dsw-alias-brand-primary, #4f6bff); background: var(--dsw-alias-bg-overlay, #fff); box-shadow: 0 1px 2px rgba(0,0,0,.14); }
.pp-diff, .pp-text {
  margin: 8px 12px 4px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #f7f8fa);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06));
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 11.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
  max-height: 300px; overflow: auto; color: var(--dsw-alias-label, #1f2329);
}
.pp-del { background: color-mix(in srgb, #e06c75 20%, transparent); color: color-mix(in srgb, #e06c75 62%, var(--dsw-alias-label, #1f2329)); border-radius: 3px; padding: 0 1px; text-decoration: line-through; text-decoration-thickness: 1px; }
.pp-ins { background: color-mix(in srgb, #7fbf7f 20%, transparent); color: color-mix(in srgb, #7ac07a 60%, var(--dsw-alias-label, #1f2329)); border-radius: 3px; padding: 0 1px; }
.pp-notes { margin: 4px 12px 10px; color: var(--dsw-alias-label-dimmed, #8a9099); font-size: 11px; }
.pp-notes-title { font-weight: 600; margin-bottom: 2px; }
.pp-notes ul { margin: 0; padding-left: 16px; }
.pp-notes-confirm {
  color: var(--dsw-alias-danger, #d93026);
  background: color-mix(in srgb, #e06c75 8%, transparent);
  border-left: 2px solid color-mix(in srgb, #e06c75 55%, transparent);
  padding: 6px 8px; border-radius: 6px;
}
.pp-empty {
  margin: 14px; padding: 16px 14px; border: 1px dashed color-mix(in srgb, var(--dsw-alias-border-l2, rgba(0,0,0,.14)) 90%, transparent);
  border-radius: 12px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 55%, transparent);
  color: var(--dsw-alias-label-dimmed, #8a9099);
}
.pp-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f7f8fa) 45%, transparent);
}
.pp-auto { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-caption, #9aa0a8); font-size: 11px; cursor: pointer; user-select: none; }
.pp-auto input { margin: 0; accent-color: var(--dsw-alias-brand-primary, #4f6bff); }
.pp-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.pp-btn {
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2, rgba(0,0,0,.14)) 85%, transparent);
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label, #1f2329);
  border-radius: 8px; padding: 5px 12px; font-size: 11px; cursor: pointer;
  transition: background .12s, border-color .12s, box-shadow .12s, transform .12s;
}
.pp-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f2f3f5); }
.pp-btn:active:not(:disabled) { transform: translateY(1px); }
.pp-btn:disabled { opacity: .42; cursor: default; }
.pp-btn-primary {
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 88%, #ffffff),
    var(--dsw-alias-brand-primary, #4f6bff));
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 70%, #000000);
  color: #fff; font-weight: 600;
  box-shadow: 0 4px 12px -6px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 80%, transparent);
}
.pp-btn-primary:hover:not(:disabled) { filter: brightness(1.07); background: linear-gradient(180deg,
    color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 92%, #ffffff),
    var(--dsw-alias-brand-primary, #4f6bff)); }
.pp-link { border: 0; background: transparent; color: var(--dsw-alias-brand-primary, #4f6bff); padding: 0; font-size: 11px; cursor: pointer; text-decoration: underline; }
.pp-hint { color: var(--dsw-alias-danger, #d93026); }
.pp-toast { color: var(--dsw-alias-label-caption, #9aa0a8); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-context { font-size: 10.5px; color: var(--dsw-alias-brand-primary, #4f6bff); opacity: .9; }
.pp-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.pp-modes { display: flex; gap: 4px; padding: 8px 12px 0; flex-shrink: 0; }
.pp-mode {
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-caption, #9aa0a8);
  border-radius: 8px; padding: 4px 10px; font-size: 11px; cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.pp-mode:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #eef0f3) 70%, transparent); color: var(--dsw-alias-label, #1f2329); }
.pp-mode.is-active {
  color: var(--dsw-alias-brand-primary, #4f6bff); font-weight: 600;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 10%, transparent);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6bff) 24%, transparent);
}
.pp-mode:disabled { opacity: .45; cursor: default; }
.pp-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        const getLocale = () => {
          try {
            const active = ctx.get('locale')?.getLocale?.()?.active
            return active === 'en' ? 'en' : 'zh'
          } catch {
            return 'zh'
          }
        }
        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'prompt-polisher',
          order: 30,
          label: 'Polish prompt',
          inject: (sessionId) => ({ getLocale, sessionId, api: ctx }),
        }, Polisher)), 'prompt-polisher: composer entry')
      },
    }
  },
})
