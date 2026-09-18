/**
 * dsh-plugin-web-search — browser half.
 *
 * Shipped in the module-loader bundle form: this file's only job is to register a factory with
 * the shell's loader, which materializes it as a plugin when the web shell needs it. `react` is
 * resolved from the platform baseline, so this bundle requests nothing else.
 *
 * One surface, additive: `settings.plugin.item` (key `web-search`) — a collapsible configuration
 * card under Settings → Configuration → Plugin configuration. The section supplies only the slot;
 * the card owns its whole shell (header, disclosure, body, copy), which is why it draws its own
 * chrome rather than assuming a wrapper exists. It reaches the host half over that row's own route
 * with a plain `fetch`; no client service other than `slots` and `locale` is read.
 *
 * The card offers two selections — a search provider and a fetch provider — because the seam keeps
 * two registries and one `web` row configures both. Adapter options are labelled by FORMAT
 * ("兼容 Jina 格式"), never by vendor: any deployment implementing that contract qualifies.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-web-search',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useState } = React

    /** Client services this bundle reads; an undeclared read is denied. */
    const inject = ['slots', 'locale']

    /** Settings namespace — also this card's slot key, and the host's settings section. */
    const NS = 'web-search'

    /** Named-route prefix the host half owns on the composition's web server. */
    const ROUTE_PREFIX = '/web-search'

    /** Endpoint names; duplicated from the host half, and compared by `test/client.test.mjs`. */
    const ENDPOINTS = {
      state: 'state/read',
      save: 'config/save',
      restore: 'takeover/restore',
    }

    /** CSS class prefix, so every selector this card draws stays in its own namespace. */
    const CLS = 'web-search'

    /** The in-box fetch provider; it needs no endpoint and fetches from the harness host. */
    const BUILTIN_FETCH_PROVIDER = 'http'

    const COPY_ZH = {
      cardTitle: 'Web Search',
      cardDesc: '选择搜索与抓取 provider，并接管 web 行',
      expand: '展开',
      collapse: '收起',
      unconfigured: '未配置',
      takeoverActive: '已接管',
      takeoverInactive: '未接管',
      unsaved: '未保存',
      description: '保存后写入本机的 home patch 层并立即生效，无需重启。两边的选择都必须显式指定：同一能力注册了多个 provider 时，接缝无法自动选中。',
      searchProviderLabel: '搜索 provider',
      searchProviderHint: '按「格式」选择，而不是按厂商——任何实现该格式的服务都可以，端点自己填。',
      fetchProviderLabel: '抓取 provider',
      fetchProviderHint: '内置 http 在本机抓取（要求本机能解析真实公网 IP）；其余选项把抓取交给远端服务。',
      adapterSearxng: '兼容 SearxNG 格式',
      adapterJina: '兼容 Jina 格式',
      adapterFirecrawl: '兼容 Firecrawl 格式',
      builtinFetch: '内置 http（本机抓取）',
      endpointLabel: '端点',
      endpointHintSearch: '该搜索服务真实的完整端点 URL，例如 https://searx.example.org/search。插件只追加 q 与 format=json，不补路径、不去尾斜杠。',
      endpointHintJina: 'Jina 格式把目标 URL 直接拼在你填的地址之后，所以这里填的是前缀（SaaS 是 https://r.jina.ai，自建则是你的服务地址）。',
      endpointHintFirecrawl: 'Firecrawl 格式把目标 URL 放进 POST body，所以这里填完整的 scrape 端点，例如 https://api.firecrawl.dev/v2/scrape。',
      endpointHintOther: '该 provider 由其它插件注册，端点与凭证请在它自己的配置页填写。',
      headersLabel: '自定义 header（JSON）',
      headersHint: '例如 {"X-API-Key":"…"} 或 {"Authorization":"Bearer …"}。留空表示不发送任何自定义 header。协议级 header（content-type、host 等）会被忽略。',
      headersInvalid: '不是合法的 JSON 对象',
      takeoverPath: '管理块文件',
      adapterUnconfigured: '该格式尚未填写端点，保存后仍不可用。',
      save: '保存',
      saving: '保存中…',
      discard: '丢弃修改',
      restore: '还原为默认',
      restoreHint: '删除本插件写入的管理块，把 provider 选择交还给 profile patch 与 dsh 默认值。',
      loading: '正在读取配置…',
      loadFailed: '读取配置失败',
      retry: '重试',
      saved: '已保存，下一次调用生效',
      unsavedDraftBlocked: '请先修正标红的字段',
    }

    const COPY_EN = {
      cardTitle: 'Web Search',
      cardDesc: 'Choose the search and fetch providers, and take over the web row',
      expand: 'Expand',
      collapse: 'Collapse',
      unconfigured: 'Not configured',
      takeoverActive: 'Taken over',
      takeoverInactive: 'Not taken over',
      unsaved: 'Unsaved',
      description: 'Saving writes this machine\'s home patch layer and applies to the next call, with no restart. Both selections are required: with several providers registered per capability the seam cannot auto-select.',
      searchProviderLabel: 'Search provider',
      searchProviderHint: 'Pick a FORMAT, not a vendor — any service implementing it qualifies, and you supply the endpoint.',
      fetchProviderLabel: 'Fetch provider',
      fetchProviderHint: 'The in-box http provider fetches from this host (it needs real public DNS); the others delegate fetching to a remote service.',
      adapterSearxng: 'Compatible with the SearxNG format',
      adapterJina: 'Compatible with the Jina format',
      adapterFirecrawl: 'Compatible with the Firecrawl format',
      builtinFetch: 'In-box http (fetches from this host)',
      endpointLabel: 'Endpoint',
      endpointHintSearch: 'The service\'s real, complete search endpoint, e.g. https://searx.example.org/search. The plugin appends only q and format=json — never a path, never a slash fix-up.',
      endpointHintJina: 'The Jina format appends the target URL to whatever you put here, so this is a prefix (https://r.jina.ai for the SaaS, your own address when self-hosted).',
      endpointHintFirecrawl: 'The Firecrawl format puts the target URL in the POST body, so this is the complete scrape endpoint, e.g. https://api.firecrawl.dev/v2/scrape.',
      endpointHintOther: 'This provider is registered by another plugin; configure its endpoint and credential on that plugin\'s own page.',
      headersLabel: 'Custom headers (JSON)',
      headersHint: 'For example {"X-API-Key":"…"} or {"Authorization":"Bearer …"}. Empty sends no custom header. Protocol-level names (content-type, host, …) are ignored.',
      headersInvalid: 'not a valid JSON object',
      takeoverPath: 'Managed block file',
      adapterUnconfigured: 'This format has no endpoint yet, so it stays unusable after saving.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      restore: 'Restore default',
      restoreHint: 'Remove the managed block this plugin wrote, handing provider selection back to the profile patch and dsh defaults.',
      loading: 'Reading configuration…',
      loadFailed: 'Could not read the configuration',
      retry: 'Retry',
      saved: 'Saved — applies to the next call',
      unsavedDraftBlocked: 'Fix the highlighted fields first',
    }

    // ── narrowing ───────────────────────────────────────────────────────────────────────

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function readText(value) {
      return typeof value === 'string' ? value : ''
    }

    /** One request to the host half's route; the body is always JSON, `{}` when empty. */
    async function request(endpoint, payload) {
      const origin = globalThis.location?.origin
      const base = origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
      const response = await fetch(new URL(ROUTE_PREFIX + '/' + endpoint, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const answered = await response.json().catch(() => null)
      if (response.ok && isRecord(answered) && answered.ok === true) return answered.value
      const error = isRecord(answered) && isRecord(answered.error) ? answered.error : null
      throw new Error(
        error === null
          ? endpoint + ' refused: HTTP ' + String(response.status)
          : readText(error.code) + ': ' + readText(error.message),
      )
    }

    /** Re-narrow the host's reply: the browser half never trusts the host's shape. */
    function decodeState(value) {
      if (!isRecord(value)) return null
      const selected = isRecord(value.selected) ? value.selected : {}
      const registered = isRecord(value.registered) ? value.registered : {}
      const takeover = isRecord(value.takeover) ? value.takeover : {}
      const adapters = (Array.isArray(value.adapters) ? value.adapters : [])
        .filter((entry) => isRecord(entry) && readText(entry.id).length > 0)
        .map((entry) => ({
          id: readText(entry.id),
          kind: readText(entry.kind),
          labelKey: readText(entry.labelKey),
          endpoint: readText(entry.endpoint),
          headers: readText(entry.headers),
        }))
      return {
        adapters,
        selected: { search: readText(selected.search), fetch: readText(selected.fetch) },
        registered: {
          search: (Array.isArray(registered.search) ? registered.search : []).map(readText),
          fetch: (Array.isArray(registered.fetch) ? registered.fetch : []).map(readText),
        },
        detectedFetchProvider: readText(value.detectedFetchProvider),
        takeoverActive: takeover.active === true,
        takeoverPath: readText(takeover.path),
      }
    }

    /** @returns the decoded adapter entry with this id, or `undefined`. */
    function adapterEntry(state, id) {
      return state === null ? undefined : state.adapters.find((entry) => entry.id === id)
    }

    /**
     * The option list for one side: this plugin's own adapters first, then whatever else the
     * deployment registered, then the current selection even if it is no longer registered — a
     * stale value must stay visible so the user can move off it.
     */
    function providerChoices(state, kind, selected) {
      const own = state.adapters.filter((entry) => entry.kind === kind)
      const ownIds = new Set(own.map((entry) => entry.id))
      const extras = state.registered[kind].filter((id) => !ownIds.has(id))
      const choices = [
        ...own.map((entry) => ({ id: entry.id, labelKey: entry.labelKey, own: true })),
        ...extras.map((id) => ({
          id,
          labelKey: id === BUILTIN_FETCH_PROVIDER && kind === 'fetch' ? 'builtinFetch' : '',
          own: false,
        })),
      ]
      if (selected.length > 0 && !choices.some((choice) => choice.id === selected)) {
        choices.push({ id: selected, labelKey: '', own: false })
      }
      return choices
    }

    /**
     * Local pre-check for the header draft, so the field can report a problem while typing.
     * The host is still the only authority: it revalidates and owns the refusal.
     *
     * @param draft - the raw header text.
     * @returns `null` when acceptable, else the JSON parse reason.
     */
    function headerDraftProblem(draft) {
      const source = draft.trim()
      if (source.length === 0) return null
      try {
        const parsed = JSON.parse(source)
        return isRecord(parsed) ? null : 'shape'
      } catch (error) {
        return error instanceof Error ? error.message : 'parse'
      }
    }

    /** @returns the draft's endpoint hint key, chosen by the kind of adapter selected. */
    function endpointHintKey(state, kind, providerId) {
      const entry = adapterEntry(state, providerId)
      if (entry === undefined) return 'endpointHintOther'
      if (entry.kind === 'search') return 'endpointHintSearch'
      if (entry.id === 'jina') return 'endpointHintJina'
      if (entry.id === 'firecrawl') return 'endpointHintFirecrawl'
      return 'endpointHintOther'
    }

    // ── copy ────────────────────────────────────────────────────────────────────────────

    /** @returns a key-to-text function that prefers the projected `t` and never assumes it. */
    function makeCopy(props) {
      const projected = typeof props.t === 'function' ? props.t : null
      const fallback =
        typeof globalThis.navigator?.language === 'string' && globalThis.navigator.language.startsWith('zh') ? COPY_ZH : COPY_EN
      return (key) => {
        if (projected !== null) {
          const projectedText = readText(projected(key))
          if (projectedText.length > 0) return projectedText
        }
        return fallback[key] ?? key
      }
    }

    // ── chrome ──────────────────────────────────────────────────────────────────────────

    /**
     * The card shell. The section supplies no wrapper — a card that renders bare fields looks
     * like a dump of the configuration, which is exactly what the collapsible header exists to
     * avoid: the page shows one summary line per plugin and reveals the form on demand.
     */
    const SHELL = {
      card: {
        listStyle: 'none',
        margin: 0,
        border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        borderRadius: '16px',
        transition: 'border-color .16s, background .16s',
      },
      cardOpen: {
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        borderColor: 'var(--dsw-alias-label-dimmed, rgba(128,128,128,0.5))',
      },
      header: {
        appearance: 'none',
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        background: 'none',
        border: 0,
        borderRadius: '12px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
      },
      headText: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 },
      name: { color: 'var(--dsw-alias-label-primary, inherit)', fontSize: '15px', fontWeight: 600, lineHeight: 1.4 },
      desc: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '13px', lineHeight: 1.5 },
      chevron: { flex: 'none', color: 'var(--dsw-alias-label-tertiary, inherit)', transition: 'transform .16s' },
      tag: {
        flex: 'none',
        borderRadius: '6px',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16))',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        padding: '1px 6px',
        fontSize: '11px',
        lineHeight: '16px',
      },
      tagOn: { background: 'rgba(64,128,255,0.16)', color: 'var(--dsw-alias-brand-primary, inherit)' },
      body: {
        borderTop: '.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
        margin: '0 16px',
        paddingBottom: '8px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
      label: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: '13px', lineHeight: 1.5 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        height: '34px',
        border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.3))',
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        font: 'inherit',
        color: 'var(--dsw-alias-label-primary, inherit)',
        borderRadius: '8px',
        padding: '0 12px',
        fontSize: '13px',
        lineHeight: 1.5,
      },
      select: { cursor: 'pointer' },
      textarea: { height: 'auto', minHeight: '64px', padding: '8px 12px', resize: 'vertical' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      hint: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '12px', lineHeight: 1.5 },
      bad: { color: '#d9534f' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', paddingTop: '10px' },
      button: {
        boxSizing: 'border-box',
        padding: '6px 12px',
        fontSize: '13px',
        borderRadius: '8px',
        border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.3))',
        background: 'none',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: { background: 'rgba(64,128,255,0.14)', borderColor: 'rgba(64,128,255,0.5)' },
      notice: { color: 'var(--dsw-alias-label-tertiary, inherit)', fontSize: '12px', paddingTop: '6px' },
      group: { borderTop: '.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))', paddingTop: '4px' },
      groupFirst: { borderTop: 'none' },
    }

    /** @returns the disclosure chevron, rotated when the card is open. */
    function chevron(open) {
      return React.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          style: open ? { ...SHELL.chevron, transform: 'rotate(180deg)' } : SHELL.chevron,
        },
        React.createElement('path', {
          d: 'M4 6l4 4 4-4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ── card ────────────────────────────────────────────────────────────────────────────

    /**
     * The configuration card. Collapsed by default — the page shows one summary line per plugin
     * — and it reveals the form on demand. Every control renders staged text, so what is on
     * screen is exactly what a save would store, and the host's read-back is the only
     * confirmation.
     */
    function ConfigCard(props) {
      const t = makeCopy(props)
      const [open, setOpen] = useState(false)
      const [phase, setPhase] = useState('loading')
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)

      /** The staged draft for one side, seeded from the host's state. */
      const draftFor = (next, kind, providerId) => {
        const entry = adapterEntry(next, providerId)
        const selectedFetch = next.selected.fetch
        const isBuiltin = kind === 'fetch' && selectedFetch === BUILTIN_FETCH_PROVIDER
        const configured = entry !== undefined && !(isBuiltin && entry.id === BUILTIN_FETCH_PROVIDER)
        return {
          provider: providerId,
          endpoint: configured ? entry.endpoint : '',
          headers: configured ? entry.headers : '',
        }
      }

      const adopt = useCallback((next) => {
        setState(next)
        setDraft(
          next === null
            ? null
            : {
                search: draftFor(next, 'search', next.selected.search),
                fetch: draftFor(next, 'fetch', next.selected.fetch),
              },
        )
      }, [])

      const load = useCallback(async () => {
        setPhase('loading')
        setNotice('')
        try {
          adopt(decodeState(await request(ENDPOINTS.state, {})))
          setPhase('ready')
        } catch (error) {
          setPhase('failed')
          setNotice(error instanceof Error ? error.message : String(error))
          setOpen(true)
        }
      }, [adopt])

      useEffect(() => {
        let live = true
        request(ENDPOINTS.state, {})
          .then((value) => {
            if (!live) return
            adopt(decodeState(value))
            setPhase('ready')
          })
          .catch((error) => {
            if (!live) return
            setPhase('failed')
            setNotice(error instanceof Error ? error.message : String(error))
            // A failure behind a collapsed header is invisible, so the card reveals itself.
            setOpen(true)
          })
        return () => {
          live = false
        }
      }, [adopt])

      const sameSide = (a, b) => a.provider === b.provider && a.endpoint === b.endpoint && a.headers === b.headers
      // "Changed" means the draft differs from what the host reported — a selection move, or an
      // edit inside one side's endpoint or header draft.
      const changes =
        state !== null &&
        draft !== null &&
        (draft.search.provider !== state.selected.search ||
          draft.fetch.provider !== state.selected.fetch ||
          !sameSide(draft.search, draftFor(state, 'search', draft.search.provider)) ||
          !sameSide(draft.fetch, draftFor(state, 'fetch', draft.fetch.provider)))

      const searchProblem = draft === null ? null : headerDraftProblem(draft.search.headers)
      const fetchProblem = draft === null ? null : headerDraftProblem(draft.fetch.headers)
      const searchOwn = state !== null && adapterEntry(state, draft.search.provider) !== undefined
      const fetchOwn = state !== null && adapterEntry(state, draft.fetch.provider) !== undefined
      const configured = state !== null && state.selected.search.length > 0

      const commit = useCallback(
        async (endpoint) => {
          setBusy(true)
          setNotice('')
          try {
            adopt(decodeState(await request(endpoint, {})))
            setPhase('ready')
          } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        },
        [adopt],
      )

      const save = useCallback(async () => {
        if (draft === null || searchProblem !== null || fetchProblem !== null) {
          setNotice(t('unsavedDraftBlocked'))
          return
        }
        setBusy(true)
        setNotice('')
        try {
          const value = await request(ENDPOINTS.save, { search: draft.search, fetch: draft.fetch })
          adopt(decodeState(value))
          setPhase('ready')
          setNotice(t('saved'))
          setOpen(false)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [adopt, draft, searchProblem, fetchProblem, t])

      const header = React.createElement(
        'button',
        {
          type: 'button',
          className: CLS + '-cardheader',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': (open ? t('collapse') : t('expand')) + ': ' + t('cardTitle'),
          style: SHELL.header,
          onClick: () => setOpen((current) => !current),
        },
        React.createElement(
          'span',
          { className: CLS + '-headtext', style: SHELL.headText },
          React.createElement('span', { className: CLS + '-cardname', style: SHELL.name }, t('cardTitle')),
          React.createElement('span', { className: CLS + '-carddesc', style: SHELL.desc }, t('cardDesc')),
        ),
        phase === 'ready' && !configured ? React.createElement('span', { style: SHELL.tag }, t('unconfigured')) : null,
        phase === 'ready' && configured
          ? React.createElement(
              'span',
              { style: { ...SHELL.tag, ...(state.takeoverActive ? SHELL.tagOn : {}) } },
              state.takeoverActive ? t('takeoverActive') : t('takeoverInactive'),
            )
          : null,
        changes ? React.createElement('span', { style: SHELL.tag }, t('unsaved')) : null,
        chevron(open),
      )

      const shell = (children) =>
        React.createElement(
          'li',
          { className: CLS + '-card', 'data-open': open ? 'true' : 'false', style: open ? { ...SHELL.card, ...SHELL.cardOpen } : SHELL.card },
          header,
          ...children,
        )
      const body = (children) => React.createElement('div', { className: CLS + '-cardbody', style: SHELL.body }, ...children)

      if (!open) return shell([])
      if (phase === 'loading') return shell([body([React.createElement('div', { style: SHELL.field }, t('loading'))])])
      if (phase === 'failed') {
        return shell([
          body([
            React.createElement('div', { style: { ...SHELL.field, ...SHELL.bad } }, t('loadFailed')),
            React.createElement('div', { style: SHELL.notice }, notice),
            React.createElement(
              'div',
              { style: SHELL.actions },
              React.createElement('button', { type: 'button', style: { ...SHELL.button, ...SHELL.primary }, onClick: load }, t('retry')),
            ),
          ]),
        ])
      }

      const field = (labelKey, hintKey, control, hintStyle) =>
        React.createElement(
          'div',
          { className: CLS + '-field', style: SHELL.field },
          React.createElement('label', { style: SHELL.label }, t(labelKey)),
          control,
          React.createElement('div', { style: hintStyle ?? SHELL.hint }, t(hintKey)),
        )

      const providerSelect = (kind, side) =>
        React.createElement(
          'select',
          {
            className: CLS + '-input',
            style: { ...SHELL.input, ...SHELL.select },
            value: draft[side].provider,
            onChange: (event) => {
              const provider = event.target.value
              const entry = adapterEntry(state, provider)
              const isBuiltin = kind === 'fetch' && provider === BUILTIN_FETCH_PROVIDER
              setDraft({
                ...draft,
                [side]: {
                  provider,
                  endpoint: entry !== undefined && !isBuiltin ? entry.endpoint : '',
                  headers: entry !== undefined && !isBuiltin ? entry.headers : '',
                },
              })
            },
          },
          providerChoices(state, kind, draft[side].provider).map((choice) =>
            React.createElement('option', { key: choice.id, value: choice.id }, choice.labelKey.length > 0 ? t(choice.labelKey) : choice.id),
          ),
        )

      const configuredFields = (side, own, problem) =>
        own
          ? [
              field(
                'endpointLabel',
                endpointHintKey(state, side, draft[side].provider),
                React.createElement('input', {
                  className: CLS + '-input',
                  style: { ...SHELL.input, ...SHELL.code },
                  value: draft[side].endpoint,
                  spellCheck: false,
                  onChange: (event) => setDraft({ ...draft, [side]: { ...draft[side], endpoint: event.target.value } }),
                }),
              ),
              field(
                'headersLabel',
                problem === null ? 'headersHint' : 'headersInvalid',
                React.createElement('textarea', {
                  className: CLS + '-input',
                  style: { ...SHELL.input, ...SHELL.textarea, ...SHELL.code },
                  value: draft[side].headers,
                  spellCheck: false,
                  placeholder: '{"X-API-Key":"…"}',
                  onChange: (event) => setDraft({ ...draft, [side]: { ...draft[side], headers: event.target.value } }),
                }),
                problem === null ? null : { ...SHELL.hint, ...SHELL.bad },
              ),
              draft[side].endpoint.trim().length === 0
                ? React.createElement('div', { style: { ...SHELL.hint, ...SHELL.bad } }, t('adapterUnconfigured'))
                : null,
            ]
          : [React.createElement('div', { style: SHELL.hint }, t('endpointHintOther'))]

      return shell([
        body([
          React.createElement('div', { style: { ...SHELL.field, ...SHELL.hint } }, t('description')),
          React.createElement('div', { className: CLS + '-group', style: { ...SHELL.group, ...SHELL.groupFirst } }, [
            field('searchProviderLabel', 'searchProviderHint', providerSelect('search', 'search')),
            ...configuredFields('search', searchOwn, searchProblem),
          ]),
          React.createElement('div', { className: CLS + '-group', style: SHELL.group }, [
            field('fetchProviderLabel', 'fetchProviderHint', providerSelect('fetch', 'fetch')),
            ...configuredFields('fetch', fetchOwn, fetchProblem),
          ]),
          React.createElement('div', { style: SHELL.hint }, t('takeoverPath') + '：' + state.takeoverPath),
          React.createElement(
            'div',
            { style: SHELL.actions },
            React.createElement(
              'button',
              { type: 'button', style: { ...SHELL.button, ...SHELL.primary }, disabled: busy || !changes, onClick: save },
              busy ? t('saving') : t('save'),
            ),
            React.createElement(
              'button',
              { type: 'button', style: SHELL.button, disabled: busy || !changes, onClick: () => adopt(state) },
              t('discard'),
            ),
            React.createElement(
              'button',
              { type: 'button', style: SHELL.button, disabled: busy, onClick: () => commit(ENDPOINTS.restore) },
              t('restore'),
            ),
          ),
          React.createElement('div', { style: SHELL.hint }, t('restoreHint')),
          notice.length > 0 ? React.createElement('div', { style: SHELL.notice }, notice) : null,
        ]),
      ])
    }

    // ── plugin ──────────────────────────────────────────────────────────────────────────

    function apply(ctx) {
      try {
        ctx.locale.register(NS, { zh: COPY_ZH, en: COPY_EN })
      } catch {
        // A composition without the locale seam still renders: makeCopy falls back by hand.
      }
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS }, ConfigCard),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
