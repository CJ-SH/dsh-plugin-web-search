/**
 * dsh-plugin-web-search — host half.
 *
 * Registers web providers with the harness web seam (`ctx.web`) and owns the machine-local
 * takeover that makes them the *selected* ones. Provider selection does not live in the settings
 * document — it is read once in `WebRuntime`'s constructor from the loader entry — so this plugin
 * writes one managed block into `$DSH_HOME/cordis.patch.yml`, the home patch layer dsh applies
 * above every profile. That layer is watched (the default profile is `patchReload: live`), so a
 * save reloads the `web` row and the next search uses the chosen provider, with no restart.
 *
 * **An adapter is identified by its wire FORMAT, not by a vendor.** `searxng`, `jina` and
 * `firecrawl` each name a request/response contract that any deployment may implement — the same
 * shape `llm-pi-ai` uses for `api: 'openai-completions'` plus a user-supplied `baseURL`. Every
 * adapter therefore dials exactly the URL the user configured and only places the target where its
 * format puts it: the query string for SearxNG, the path for Jina, the JSON body for Firecrawl.
 *
 * The browser half owns every part of the configuration card under `settings.plugin.item`.
 *
 * @module dsh-plugin-web-search
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WebError } from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'

/** Stable plugin name, loader row id, settings namespace and card key. */
export const name = 'web-search'

/**
 * `web` is the capability this plugin exists for; the rest are the route's requirements —
 * `webServer` owns the route and `connection` answers the trust fence every reply asks first.
 */
export const inject = ['web', 'settings', 'connection', 'webServer']

/** Settings namespace; also the key the browser card registers itself under. */
const NS = 'web-search'

/** Named-route prefix this half owns on the composition's `webServer`. */
const ROUTE_PREFIX = '/web-search'

/** Every endpoint reachable under {@link ROUTE_PREFIX}; anything else is a 404. */
const ENDPOINTS = new Set(['state/read', 'config/save', 'takeover/restore'])

/** Request bodies are small JSON objects; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024

/** Per-attempt budget for one provider request, combined with the caller's signal. */
const REQUEST_TIMEOUT_MS = 15_000

/** Bytes of an error body inspected for diagnostics; the rest is discarded. */
const ERROR_BODY_BYTES = 4096

/** Loader row this plugin takes over; the patch replaces its whole `config`. */
const WEB_ENTRY_ID = 'web'

/** The home patch layer file name, as dsh names it. */
const PATCH_FILENAME = 'cordis.patch.yml'

/** Managed-block sentinels: the idempotence anchor inside the user's patch file. */
const MANAGED_BEGIN = '# >>> dsh-plugin-web-search (managed block; do not edit) >>>'
const MANAGED_END = '# <<< dsh-plugin-web-search <<<'

/**
 * Headers this plugin refuses to let a user override. They are protocol-level: a wrong
 * `content-length` or `host` corrupts the request rather than configuring it. `accept`,
 * `authorization` and `user-agent` are deliberately absent — a deployment needs its own.
 */
const RESERVED_HEADERS = new Set([
  'connection',
  'content-length',
  'content-type',
  'host',
  'transfer-encoding',
  'accept-encoding',
])

/** Defaults for the two selection fields. */
const DEFAULT_SEARCH_PROVIDER = 'searxng'

/** The fetch provider dsh ships in-box; it needs no endpoint and fetches from this host. */
const BUILTIN_FETCH_PROVIDER = 'http'

/** Fallback fetch provider when nothing usable can be detected. */
const DEFAULT_FETCH_PROVIDER = BUILTIN_FETCH_PROVIDER

// ── narrowing helpers ────────────────────────────────────────────────────────────────────

/** @returns true for a plain object, never for an array or `null`. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns the string when it is one, else `''`; `''` therefore means "absent". */
function text(value) {
  return typeof value === 'string' ? value : ''
}

/** @returns a readable message for anything thrown or rejected. */
function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.length > 0) return error.message
  const rendered = String(error)
  return rendered.length > 0 ? rendered : 'unknown error'
}

/** @returns the finite number, else the fallback. `0` is meaningful and survives. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** @returns the object's own keys, or an empty list for a non-object. */
function keysOf(value) {
  return isRecord(value) ? Object.keys(value) : []
}

/**
 * Strip the trailing slashes a user may have pasted. Only the *separator* is normalised — the
 * path itself is never rewritten, because an adapter dials exactly what it was given.
 *
 * @param endpoint - the configured endpoint.
 * @returns the endpoint without trailing slashes.
 */
function trimSlashes(endpoint) {
  return text(endpoint).trim().replace(/\/+$/, '')
}

// ── request plumbing shared by every adapter ─────────────────────────────────────────────

/**
 * Parse the user's custom-header JSON. Values that are empty are dropped (a blank is
 * "send nothing", not "send an empty header"), and protocol-level names are dropped with a
 * reason so the card can report what was ignored rather than silently changing the request.
 *
 * @param raw - the settings string, expected to be a JSON object of string values.
 * @returns `{ ok: true, headers, dropped }` or `{ ok: false, reason }`.
 */
export function parseHeadersJson(raw) {
  const source = text(raw).trim()
  if (source.length === 0) return { ok: true, headers: {}, dropped: [] }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${errorMessage(error)}` }
  }
  if (!isRecord(parsed)) return { ok: false, reason: '必须是一个 JSON 对象，例如 {"X-API-Key":"…"}' }
  const headers = {}
  const dropped = []
  for (const [rawName, rawValue] of Object.entries(parsed)) {
    const headerName = rawName.trim()
    if (headerName.length === 0) return { ok: false, reason: 'header 名不能为空' }
    if (typeof rawValue !== 'string') return { ok: false, reason: `header "${headerName}" 的值必须是字符串` }
    if (rawValue.length === 0) continue
    if (RESERVED_HEADERS.has(headerName.toLowerCase())) {
      dropped.push(headerName)
      continue
    }
    headers[headerName] = rawValue
  }
  return { ok: true, headers, dropped }
}

/**
 * Combine the caller's cancellation with one provider-side attempt budget. The timer is
 * unref'd so a pending request never holds the process open.
 *
 * @param signal - the caller's signal, from the tool-call budget.
 * @param timeoutMs - this attempt's budget in milliseconds.
 * @returns the derived signal, a timeout probe, and the cleanup.
 */
function requestAttempt(signal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref()
  const onCallerAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) onCallerAbort()
  else signal?.addEventListener('abort', onCallerAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Build a provider's stable cancellation error while retaining the caller's reason. */
function aborted(label, signal, fallback) {
  return new WebError(`${label} aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/**
 * Turn a failed HTTP response into a message that names the actual cause. Two failures share
 * `403` and `text/html` at a reverse proxy — an unaccepted credential and an instance that has
 * not enabled a machine format — so the body is inspected to tell them apart.
 *
 * @param label - the adapter's display label.
 * @param status - the HTTP status code.
 * @param contentType - the response `content-type`, already lowercased.
 * @param bodyText - the first {@link ERROR_BODY_BYTES} of the response body.
 * @returns the diagnostic message.
 */
export function classifyHttpFailure(label, status, contentType, bodyText) {
  const html = contentType.includes('html')
  if (status === 401 || status === 403) {
    if (/cloudflare|attention required|just a moment|cf-ray/i.test(bodyText)) {
      return `${label}：HTTP ${status} 被反向代理拒绝。请检查自定义 header 里的凭证。`
    }
    if (/403\s*forbidden/i.test(bodyText)) {
      return `${label}：HTTP 403，实例拒绝该输出格式。若这是 SearxNG，请在 settings.yml 的 search.formats 里启用 json。`
    }
    return `${label}：HTTP ${status}，疑似鉴权失败（检查自定义 header），或实例未启用所需格式。`
  }
  if (status === 429) return `${label}：HTTP 429，实例限流。请降低频率或调整实例的限流配置。`
  if (status === 404) return `${label}：HTTP 404，端点不存在。请确认填写的 URL 是该服务真实的端点。`
  if (html) return `${label}：HTTP ${status}，服务返回了 HTML 而不是预期格式，可能未启用机器可读输出或触发了 bot 防护。`
  return `${label}：HTTP ${status}，服务拒绝了请求。`
}

/**
 * Read the response body as text with a size-bounded excerpt for diagnostics.
 *
 * @param response - the fetch response.
 * @returns the decoded text, capped at {@link ERROR_BODY_BYTES} for the excerpt.
 */
async function readBodyExcerpt(response) {
  try {
    return (await response.text()).slice(0, ERROR_BODY_BYTES)
  } catch {
    return ''
  }
}

/**
 * Run one JSON request with the shared timeout, redirect and cancellation contract.
 *
 * @param label - the adapter's display label.
 * @param url - the absolute request URL.
 * @param init - method, headers and body for the request.
 * @param signal - the caller's signal.
 * @returns the parsed JSON body, the HTTP status and the content type.
 */
async function requestJson(label, url, init, signal) {
  const attempt = requestAttempt(signal, REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(url, { redirect: 'error', ...init, signal: attempt.signal })
  } catch (error) {
    if (signal?.aborted === true) throw aborted(label, signal, error)
    if (attempt.timedOut()) {
      throw new WebError(`${label} 请求超时（${REQUEST_TIMEOUT_MS}ms）：${url}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (/redirect/i.test(errorMessage(error))) {
      throw new WebError(`${url} 返回了重定向；请直接填写最终端点 URL。`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throw new WebError(`无法访问 ${url}：${errorMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  } finally {
    attempt.clear()
  }

  const contentType = text(response.headers.get('content-type')).toLowerCase()
  if (!response.ok) {
    throw new WebError(classifyHttpFailure(label, response.status, contentType, await readBodyExcerpt(response)), 'WEB_PROVIDER_ERROR')
  }
  const raw = await response.text()
  if (contentType.includes('json')) {
    try {
      return { json: JSON.parse(raw), status: response.status, contentType, raw }
    } catch (error) {
      throw new WebError(`${label} 声明了 JSON 但响应无法解析：${errorMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
  return { json: undefined, status: response.status, contentType, raw }
}

// ── adapter: SearxNG format (search) ─────────────────────────────────────────────────────

/**
 * Build the request URL for the SearxNG search format. The endpoint is the user's own — a
 * self-hosted instance may be mounted at any route, so no path is appended or stripped. Only the
 * two parameters SearxNG's documented search API requires are added: `q`, and `format=json`
 * (without it the instance answers HTML, because `json` is opt-in per instance).
 *
 * @param endpoint - the configured endpoint, used verbatim.
 * @param query - the search query.
 * @returns the absolute request URL.
 */
export function buildRequestUrl(endpoint, query) {
  const encoded = `q=${encodeURIComponent(query)}&format=json`
  if (endpoint.endsWith('?') || endpoint.endsWith('&')) return `${endpoint}${encoded}`
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${encoded}`
}

/**
 * Map a SearxNG JSON body onto the seam's normalized result. `results[]` is heterogeneous —
 * media results carry fields web results lack — so every field is narrow-checked and an entry
 * without a usable URL is skipped rather than repaired.
 *
 * @param body - the parsed response body.
 * @returns the seam's search result; `truncated` stays false because the seam owns the bound.
 */
export function mapSearxngResponse(body) {
  const results = isRecord(body) && Array.isArray(body.results) ? body.results : []
  const seen = new Set()
  const sources = []
  for (const entry of results) {
    if (!isRecord(entry)) continue
    const url = text(entry.url).trim()
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = text(entry.title)
    const snippet = text(entry.content)
    const publishedAt = text(entry.publishedDate)
    sources.push({
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet.length > 0 ? { snippet } : {}),
      ...(publishedAt.length > 0 ? { publishedAt } : {}),
    })
  }
  return { sources, truncated: false }
}

/** @returns the SearxNG-format search provider. */
function createSearxngSearchProvider(read) {
  const optionsOf = () => readAdapterOptions(read(), 'searxng')
  return {
    id: 'searxng',
    available() {
      const endpoint = optionsOf().endpoint.trim()
      return endpoint.length > 0 && URL.canParse(endpoint)
    },
    async search(request, signal) {
      const options = optionsOf()
      const endpoint = options.endpoint.trim()
      if (endpoint.length === 0 || !URL.canParse(endpoint)) {
        throw new WebError('SearxNG 搜索尚未配置：请在 Web Search 卡片里填写端点。', 'WEB_PROVIDER_ERROR')
      }
      const parsed = parseHeadersJson(options.headers)
      if (!parsed.ok) throw new WebError(`自定义 header 配置无效：${parsed.reason}`, 'WEB_PROVIDER_ERROR')
      const { json } = await requestJson(
        'SearxNG',
        buildRequestUrl(endpoint, request.query),
        { method: 'GET', headers: { accept: 'application/json', ...parsed.headers } },
        signal,
      )
      if (json === undefined) {
        throw new WebError(
          `${endpoint} 返回了非 JSON 内容：可能未启用 search.formats 的 json，或触发了 botdetection。`,
          'WEB_PROVIDER_ERROR',
        )
      }
      return mapSearxngResponse(json)
    },
  }
}

// ── adapter: Jina format (fetch) ─────────────────────────────────────────────────────────

/**
 * Build the request URL for the Jina Reader format: the target URL is appended to the endpoint
 * path, verbatim and unencoded, which is what `https://r.jina.ai/<url>` does.
 *
 * @param endpoint - the configured endpoint (a base the target is appended to).
 * @param target - the page to read.
 * @returns the absolute request URL.
 */
export function buildJinaUrl(endpoint, target) {
  return `${trimSlashes(endpoint)}/${target}`
}

/**
 * Decode the Jina Reader envelope. Structured mode answers
 * `{ code, status, data: { title, url, content, publishedTime, ... } }`; a plain-text answer
 * (the `text/plain` default) is handled by the caller.
 *
 * @param json - the parsed body.
 * @param httpStatus - the HTTP status, used when the envelope omits one.
 * @returns the normalized fetch outcome.
 */
export function decodeJina(json, httpStatus) {
  const data = isRecord(json) && isRecord(json.data) ? json.data : {}
  const content = text(data.content)
  return {
    kind: 'text',
    content,
    url: text(data.url),
    statusCode: numberOr(data.httpStatus, httpStatus),
    title: text(data.title),
  }
}

/** @returns the Jina-format fetch provider. */
function createJinaFetchProvider(read) {
  const optionsOf = () => readAdapterOptions(read(), 'jina')
  return {
    id: 'jina',
    available() {
      const endpoint = optionsOf().endpoint.trim()
      return endpoint.length > 0 && URL.canParse(endpoint)
    },
    async fetch(request, signal) {
      const options = optionsOf()
      const endpoint = options.endpoint.trim()
      if (endpoint.length === 0 || !URL.canParse(endpoint)) {
        throw new WebError('兼容 Jina 格式的抓取尚未配置：请在 Web Search 卡片里填写端点。', 'WEB_PROVIDER_ERROR')
      }
      const parsed = parseHeadersJson(options.headers)
      if (!parsed.ok) throw new WebError(`自定义 header 配置无效：${parsed.reason}`, 'WEB_PROVIDER_ERROR')
      const { json, status, contentType, raw } = await requestJson(
        'Jina Reader',
        buildJinaUrl(endpoint, request.url),
        // `accept: application/json` asks for the envelope; a deployment that ignores it answers
        // text/plain, which is equally valid and is used verbatim.
        { method: 'GET', headers: { accept: 'application/json', ...parsed.headers } },
        signal,
      )
      if (json === undefined) {
        if (contentType.includes('html')) return { url: request.url, statusCode: status, body: { kind: 'html', content: raw }, truncated: false }
        return { url: request.url, statusCode: status, body: { kind: 'text', content: raw }, truncated: false }
      }
      const outcome = decodeJina(json, status)
      const content = outcome.content.length > 0 ? outcome.content : pickLooseText(json)
      if (content.length === 0) {
        // A 200 with no readable text is the one failure an operator cannot guess at, so the
        // diagnostic names the keys the deployment actually sent.
        throw new WebError(
          `Jina 格式的响应里没有可识别的文本字段；实际看到：${describeShape(json)}`,
          'WEB_PROVIDER_ERROR',
        )
      }
      return {
        url: outcome.url.length > 0 ? outcome.url : request.url,
        statusCode: outcome.statusCode,
        body: { kind: 'text', content },
        truncated: false,
      }
    },
  }
}

// ── adapter: Firecrawl format (fetch) ────────────────────────────────────────────────────

/** The Firecrawl scrape request body this adapter sends. */
export function buildFirecrawlBody(target) {
  return { url: target, formats: ['markdown'], onlyMainContent: true }
}

/**
 * Decode the Firecrawl scrape envelope:
 * `{ success, data: { markdown, html, metadata: { title, sourceURL, statusCode } } }`.
 *
 * @param json - the parsed body.
 * @param httpStatus - the HTTP status, used when the envelope omits one.
 * @returns the normalized fetch outcome.
 */
export function decodeFirecrawl(json, httpStatus) {
  const root = isRecord(json) ? json : {}
  const data = isRecord(root.data) ? root.data : {}
  const metadata = isRecord(data.metadata) ? data.metadata : {}
  const markdown = text(data.markdown)
  const html = text(data.html).length > 0 ? text(data.html) : text(data.rawHtml)
  return {
    kind: markdown.length > 0 ? 'text' : 'html',
    content: markdown.length > 0 ? markdown : html,
    url: text(metadata.sourceURL),
    statusCode: numberOr(metadata.statusCode, httpStatus),
    title: text(metadata.title),
    failure: root.success === false ? text(root.error).length > 0 ? text(root.error) : 'service reported success: false' : '',
  }
}

/** @returns the Firecrawl-format fetch provider. */
function createFirecrawlFetchProvider(read) {
  const optionsOf = () => readAdapterOptions(read(), 'firecrawl')
  return {
    id: 'firecrawl',
    available() {
      const endpoint = optionsOf().endpoint.trim()
      return endpoint.length > 0 && URL.canParse(endpoint)
    },
    async fetch(request, signal) {
      const options = optionsOf()
      const endpoint = options.endpoint.trim()
      if (endpoint.length === 0 || !URL.canParse(endpoint)) {
        throw new WebError('兼容 Firecrawl 格式的抓取尚未配置：请在 Web Search 卡片里填写端点。', 'WEB_PROVIDER_ERROR')
      }
      const parsed = parseHeadersJson(options.headers)
      if (!parsed.ok) throw new WebError(`自定义 header 配置无效：${parsed.reason}`, 'WEB_PROVIDER_ERROR')
      const { json, status } = await requestJson(
        'Firecrawl',
        endpoint,
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', ...parsed.headers },
          body: JSON.stringify(buildFirecrawlBody(request.url)),
        },
        signal,
      )
      if (json === undefined) {
        throw new WebError('Firecrawl 格式要求 JSON 响应，但服务返回了其它类型。', 'WEB_PROVIDER_ERROR')
      }
      const outcome = decodeFirecrawl(json, status)
      if (outcome.failure.length > 0) {
        throw new WebError(`Firecrawl 服务报告失败：${outcome.failure}`, 'WEB_PROVIDER_ERROR')
      }
      const content = outcome.content.length > 0 ? outcome.content : pickLooseText(json)
      if (content.length === 0) {
        // Same reason as the Jina adapter: name the keys so the service can be adapted.
        throw new WebError(
          `Firecrawl 格式的响应里没有可识别的文本字段；实际看到：${describeShape(json)}`,
          'WEB_PROVIDER_ERROR',
        )
      }
      return {
        url: outcome.url.length > 0 ? outcome.url : request.url,
        statusCode: outcome.statusCode,
        body: { kind: outcome.kind, content },
        truncated: false,
      }
    },
  }
}

/**
 * Last-resort text lookup for an approximately-compatible service. A format-compatible deployment
 * is not always field-exact, so a body that carried no documented field is still mined for the
 * usual names before the request is failed — with the observed keys named in the diagnostic.
 *
 * @param json - the parsed body.
 * @returns the first recognized text, or `''`.
 */
export function pickLooseText(json) {
  const root = isRecord(json) ? json : {}
  const data = isRecord(root.data) ? root.data : {}
  const candidates = [
    root.content, root.text, root.markdown, root.body, root.result,
    data.content, data.text, data.markdown, data.body,
  ]
  for (const candidate of candidates) {
    const value = text(candidate)
    if (value.length > 0) return value
  }
  return ''
}

/** @returns the key names a diagnostic should name, so an operator can adapt their service. */
export function describeShape(json) {
  const root = isRecord(json) ? json : {}
  const data = isRecord(root.data) ? root.data : {}
  const observed = [...keysOf(root), ...keysOf(data).map((key) => `data.${key}`)]
  return observed.length > 0 ? observed.join(', ') : '(empty body)'
}

// ── the adapter table ───────────────────────────────────────────────────────────────────

/**
 * Every format this plugin implements. `kind` decides which seam registry the adapter joins;
 * `labelKey` is the card's copy key and deliberately names the FORMAT — a deployment that
 * implements the same contract is not the vendor whose name the format carries.
 */
export const ADAPTERS = [
  { id: 'searxng', kind: 'search', labelKey: 'adapterSearxng', build: createSearxngSearchProvider },
  { id: 'jina', kind: 'fetch', labelKey: 'adapterJina', build: createJinaFetchProvider },
  { id: 'firecrawl', kind: 'fetch', labelKey: 'adapterFirecrawl', build: createFirecrawlFetchProvider },
]

/** @returns the adapters of one capability kind. */
export function adaptersOf(kind) {
  return ADAPTERS.filter((adapter) => adapter.kind === kind)
}

/** @returns the adapter with this id, or `undefined`. */
export function adapterById(id) {
  return ADAPTERS.find((adapter) => adapter.id === id)
}

// ── settings section ─────────────────────────────────────────────────────────────────────

/**
 * One adapter's own configuration, keyed by adapter id rather than by capability, so one dict
 * covers both sides and adding an adapter never changes this schema — the same shape the shipped
 * `llm-pi-ai` row uses for its provider profiles.
 */
const adapterSettings = z.object({
  /** The endpoint this adapter dials, exactly as the user gave it. */
  endpoint: z.string().default(''),
  /** Custom headers as a JSON object string, e.g. `{"X-API-Key":"…"}`. */
  headers: z.string().default(''),
})

/** The settings section this plugin owns. */
export const Config = z.object({
  /** Selected search adapter id. */
  provider: z.string().default(DEFAULT_SEARCH_PROVIDER),
  /** Selected fetch provider id — an adapter of ours, or a provider another row registered. */
  fetchProvider: z.string().default(DEFAULT_FETCH_PROVIDER),
  /** Per-adapter configuration, keyed by adapter id across both capabilities. */
  providers: z.dict(adapterSettings).default({}),
})

/** @returns the configured options for one adapter, never `undefined`. */
function readAdapterOptions(config, adapterId) {
  const providers = isRecord(config) && isRecord(config.providers) ? config.providers : {}
  const entry = isRecord(providers[adapterId]) ? providers[adapterId] : {}
  return { endpoint: text(entry.endpoint), headers: text(entry.headers) }
}

/** @returns the configured search adapter id, falling back to the shipped default. */
function readSelectedSearch(config) {
  const configured = text(isRecord(config) ? config.provider : '').trim()
  return configured.length > 0 ? configured : DEFAULT_SEARCH_PROVIDER
}

/** @returns the configured fetch provider id, falling back to the in-box provider. */
function readSelectedFetch(config) {
  const configured = text(isRecord(config) ? config.fetchProvider : '').trim()
  return configured.length > 0 ? configured : DEFAULT_FETCH_PROVIDER
}

/**
 * Read one of the seam's provider registries. The registry is a plain `Map` on the service, so a
 * configuration surface can list what this deployment actually registered — including providers
 * this plugin did not contribute. It is a **read**, never a mutation, and an unreadable registry
 * degrades to an empty list rather than failing the card.
 *
 * @param ctx - plugin context.
 * @param kind - which registry to read.
 * @returns the registered provider ids.
 */
export function listRegisteredProviders(ctx, kind) {
  try {
    const web = ctx.get('web')
    if (web === undefined) return []
    const registry = kind === 'search' ? web.searchProviders : web.fetchProviders
    if (!(registry instanceof Map)) return []
    return [...registry.keys()].filter((id) => typeof id === 'string').sort()
  } catch {
    return []
  }
}

// ── home patch layer ─────────────────────────────────────────────────────────────────────

/** Expand a leading `~`, `~/` or `~\\` against the OS home, as dsh itself does. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve `$DSH_HOME`. Mirrors dsh's precedence — an explicit value, then `$DSH_HOME`, then
 * `~/.dsh` — so this plugin and the harness can never disagree about which file is the home
 * patch layer.
 *
 * @returns the absolute harness home path.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return resolve(expandHome(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')))
}

/** @returns the absolute path of the home patch layer (`$DSH_HOME/cordis.patch.yml`). */
export function homePatchPath() {
  return join(resolveDshHome(), PATCH_FILENAME)
}

/** @returns the file's text, or `undefined` when it does not exist or cannot be read. */
function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Render the managed block. The `web` patch replaces the row's **whole** `config`, so both
 * selection keys must be stated: omitting one would re-inherit the schema default and silently
 * change a capability the user did not touch. Both are also mandatory at runtime, because
 * registering more than one provider per capability makes the seam's auto-selection ambiguous.
 *
 * @param searchProvider - the search adapter id to select.
 * @param fetchProvider - the fetch provider id to select.
 * @returns the block's YAML text, sentinels included.
 */
export function renderManagedBlock(searchProvider, fetchProvider) {
  return [
    MANAGED_BEGIN,
    `- id: ${WEB_ENTRY_ID}`,
    '  config:',
    `    searchProvider: ${searchProvider}`,
    `    fetchProvider: ${fetchProvider}`,
    MANAGED_END,
  ].join('\n')
}

/** @returns true for a line that carries no YAML content. */
function isCommentOrBlank(line) {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/**
 * Remove this plugin's managed block, leaving every other byte of the user's file alone.
 *
 * @param source - the patch file's text.
 * @returns the text without the block.
 */
export function removeManagedBlock(source) {
  const begin = source.indexOf(MANAGED_BEGIN)
  if (begin < 0) return source
  const end = source.indexOf(MANAGED_END, begin)
  const tail = end < 0 ? '' : source.slice(end + MANAGED_END.length)
  const head = source.slice(0, begin).replace(/[ \t]+\n/g, '\n').replace(/\n{2,}$/, '\n')
  const rest = tail.replace(/^\r?\n/, '')
  return head + rest
}

/**
 * Insert or replace the managed block. Text-level editing is deliberate: the user's patch file
 * is hand-written and carries comments, and a YAML round-trip would discard them.
 *
 * @param source - the patch file's current text.
 * @param block - the block to place.
 * @returns the new file text.
 */
export function upsertManagedBlock(source, block) {
  const begin = source.indexOf(MANAGED_BEGIN)
  if (begin >= 0) {
    const end = source.indexOf(MANAGED_END, begin)
    if (end < 0) return `${source.slice(0, begin)}${block}\n`
    return `${source.slice(0, begin)}${block}${source.slice(end + MANAGED_END.length)}`
  }
  const lines = source.split(/\r?\n/)
  const significant = lines.findIndex((line) => !isCommentOrBlank(line))
  if (significant >= 0 && lines[significant].trim() === '[]') {
    // The shipped template's empty flow sequence: a block sequence cannot follow it, so the
    // placeholder is replaced rather than appended to.
    const next = [...lines]
    next[significant] = block
    return next.join('\n')
  }
  const body = source.replace(/\s+$/, '')
  return `${body.length > 0 ? `${body}\n\n` : ''}${block}\n`
}

/**
 * Read the fetch provider a patch layer currently states for the `web` row. Line scanning
 * again — and the only available route, because no `loader` service is exposed that could read
 * the entry's effective config.
 *
 * @param source - one patch layer's text.
 * @returns the value, or `undefined` when this layer does not state one.
 */
export function readWebEntryFetchProvider(source) {
  return readWebEntryConfigValue(source, 'fetchProvider')
}

/** @returns the search provider a patch layer states for the `web` row, or `undefined`. */
export function readWebEntrySearchProvider(source) {
  return readWebEntryConfigValue(source, 'searchProvider')
}

/** @returns one `config` value inside a patch layer's `- id: web` entry, or `undefined`. */
function readWebEntryConfigValue(source, key) {
  const lines = text(source).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== `- id: ${WEB_ENTRY_ID}`) continue
    const baseIndent = lines[index].length - lines[index].trimStart().length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (isCommentOrBlank(line)) continue
      const indent = line.length - line.trimStart().length
      if (indent <= baseIndent) break
      const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`).exec(line.trim())
      if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return undefined
}

/** The patch layers consulted when detecting what the `web` row currently states. */
function patchLayerPaths() {
  return [homePatchPath(), join(resolveDshHome(), 'profiles', 'web', PATCH_FILENAME)]
}

/**
 * Decide which fetch provider to restate. The home layer outranks the profile layer, so it is
 * consulted first; the fallback is the provider dsh ships in-box.
 *
 * @returns the fetch provider id to write.
 */
export function detectFetchProvider() {
  for (const source of patchLayerPaths()) {
    const found = readWebEntryFetchProvider(readTextFile(source) ?? '')
    if (found !== undefined && found.length > 0) return found
  }
  return DEFAULT_FETCH_PROVIDER
}

/**
 * Replace the patch file atomically: a same-directory temporary file plus a rename. An in-place
 * write would let the watcher observe a half-written file and reload the composition from it.
 *
 * @param path - the target patch file.
 * @param content - the complete new text.
 */
function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, content, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** @returns whether this plugin's block currently owns the `web` row in the home layer. */
export function takeoverActive() {
  return (readTextFile(homePatchPath()) ?? '').includes(MANAGED_BEGIN)
}

/** Apply the takeover: write the managed block into the home patch layer. */
export function applyTakeover(searchProvider, fetchProvider) {
  const path = homePatchPath()
  const current = readTextFile(path) ?? ''
  writeFileAtomic(path, upsertManagedBlock(current, renderManagedBlock(searchProvider, fetchProvider)))
}

/** Relinquish the takeover: drop the managed block, keeping the user's file otherwise intact. */
export function releaseTakeover() {
  const path = homePatchPath()
  const current = readTextFile(path)
  if (current === undefined) return
  const next = removeManagedBlock(current)
  if (next.trim().length === 0 || next.split(/\r?\n/).every(isCommentOrBlank)) {
    rmSync(path, { force: true })
    return
  }
  writeFileAtomic(path, next)
}

// ── route ────────────────────────────────────────────────────────────────────────────────

/** JSON response, never cached: provider selection and configuration are live facts. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** The single failure channel across the wire; a thrown exception is not one. */
function sendFailure(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Apply the composition's trust fence before anything else. Fails closed: a composition without
 * that seam answers 503, so this route can never serve configuration unauthenticated.
 *
 * @param ctx - plugin context; `connection` is injected by this row.
 * @param req - the incoming request (only its headers are read).
 * @param res - response owned here when the request is rejected.
 * @returns true when a rejection was written and the handler must stop.
 */
function rejected(ctx, req, res) {
  const connection = ctx.connection
  if (typeof connection?.requestRejection !== 'function') {
    console.error('[web-search] trust fence unavailable: refusing to serve')
    res.writeHead(503)
    res.end()
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection)
  res.end()
  return true
}

/** Read and parse the request body under a size cap. */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, reason: 'request body is too large' }
    chunks.push(chunk)
  }
  if (size === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, reason: 'request body is not JSON' }
  }
}

/**
 * Build the state the card renders. Every adapter is listed with its own configured options, and
 * the registered ids come from the live seam registries so the card can offer what this
 * deployment can actually serve.
 *
 * @param ctx - plugin context.
 * @param read - returns the current settings section.
 * @returns the JSON-safe state value.
 */
export function buildState(ctx, read) {
  const config = read()
  return {
    adapters: ADAPTERS.map((adapter) => {
      const options = readAdapterOptions(config, adapter.id)
      return { id: adapter.id, kind: adapter.kind, labelKey: adapter.labelKey, endpoint: options.endpoint, headers: options.headers }
    }),
    selected: { search: readSelectedSearch(config), fetch: readSelectedFetch(config) },
    registered: { search: listRegisteredProviders(ctx, 'search'), fetch: listRegisteredProviders(ctx, 'fetch') },
    detectedFetchProvider: detectFetchProvider(),
    takeover: { active: takeoverActive(), path: homePatchPath() },
  }
}

/**
 * Validate one save request into the settings patch and the managed block.
 *
 * @param payload - the narrow-checked request body.
 * @returns `{ ok: true, search, fetch, contributions }` or `{ ok: false, message }`.
 */
export function parseSaveRequest(payload) {
  const input = isRecord(payload) ? payload : {}
  const search = isRecord(input.search) ? input.search : {}
  const fetchSide = isRecord(input.fetch) ? input.fetch : {}

  // Both selections are mandatory: with several providers registered per capability, an unset
  // selection is ambiguous and the seam refuses to run at all. The per-field defaults above are
  // a last resort for a deployment that never saved; a blank submission still selects something.
  const searchProvider = text(search.provider).trim() || DEFAULT_SEARCH_PROVIDER
  const fetchProvider = text(fetchSide.provider).trim() || DEFAULT_FETCH_PROVIDER

  const checked = []
  for (const [side, provider, raw] of [['search', searchProvider, search], ['fetch', fetchProvider, fetchSide]]) {
    const adapter = adapterById(provider)
    if (adapter === undefined) continue // a provider another row owns carries no configuration here
    const endpoint = text(raw.endpoint).trim()
    if (endpoint.length > 0 && !URL.canParse(endpoint)) {
      return { ok: false, message: `${side} 端点不是合法 URL：${endpoint}` }
    }
    const headers = parseHeadersJson(raw.headers)
    if (!headers.ok) return { ok: false, message: `${side} 自定义 header 无效：${headers.reason}` }
    checked.push([provider, { endpoint, headers: text(raw.headers).trim() }])
  }

  return {
    ok: true,
    search: searchProvider,
    fetch: fetchProvider,
    contributions: checked,
  }
}

/**
 * Merge this save's adapter configurations over the stored ones and return the complete dict.
 * The whole dict is written rather than a partial patch so the result cannot depend on how deep
 * the settings service merges.
 *
 * @param config - the current settings section.
 * @param contributions - `[adapterId, options]` pairs from the validated request.
 * @returns the complete providers dict to store.
 */
export function mergeAdapterConfigs(config, contributions) {
  const current = isRecord(config) && isRecord(config.providers) ? config.providers : {}
  const next = {}
  for (const [id, entry] of Object.entries(current)) {
    if (!isRecord(entry)) continue
    next[id] = { endpoint: text(entry.endpoint), headers: text(entry.headers) }
  }
  for (const [id, options] of contributions) next[id] = options
  return next
}

/**
 * Own the route. Order is the contract: fence, then method, then media type, then endpoint,
 * then body.
 *
 * @param ctx - plugin context.
 * @param read - returns the current settings section.
 * @returns the request handler.
 */
function createHandler(ctx, read) {
  return async function handle(req, res) {
    if (rejected(ctx, req, res)) return
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const endpoint = new URL(req.url ?? '/', 'http://localhost').pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '')
    if (!ENDPOINTS.has(endpoint)) {
      sendFailure(res, 404, 'unknown-endpoint', `unknown endpoint "${endpoint}"`)
      return
    }
    const contentType = text(req.headers['content-type']).toLowerCase()
    if (!contentType.includes('application/json')) {
      sendFailure(res, 415, 'unsupported-media-type', 'content-type must be application/json')
      return
    }
    const body = await readBody(req)
    if (!body.ok) {
      sendFailure(res, body.status, body.status === 413 ? 'body-too-large' : 'bad-body', body.reason)
      return
    }

    if (endpoint === 'state/read') {
      sendJson(res, 200, { ok: true, value: buildState(ctx, read) })
      return
    }

    const settings = ctx.get('settings')
    if (settings === undefined) {
      sendFailure(res, 503, 'settings-unavailable', 'no settings provider is mounted')
      return
    }

    if (endpoint === 'takeover/restore') {
      try {
        releaseTakeover()
        sendJson(res, 200, { ok: true, value: buildState(ctx, read) })
      } catch (error) {
        sendFailure(res, 500, 'takeover-failed', `还原失败：${errorMessage(error)}`)
      }
      return
    }

    const parsed = parseSaveRequest(body.value)
    if (!parsed.ok) {
      sendFailure(res, 400, 'invalid-config', parsed.message)
      return
    }
    try {
      // Validation already ran. The settings section lands first so the card still holds the
      // typed configuration if the patch write then fails; the next save retries the takeover.
      await settings.update(NS, {
        provider: parsed.search,
        fetchProvider: parsed.fetch,
        providers: mergeAdapterConfigs(read(), parsed.contributions),
      })
      applyTakeover(parsed.search, parsed.fetch)
    } catch (error) {
      sendFailure(res, 500, 'save-failed', `保存失败：${errorMessage(error)}`)
      return
    }
    sendJson(res, 200, { ok: true, value: buildState(ctx, read) })
  }
}

// ── plugin ───────────────────────────────────────────────────────────────────────────────

/**
 * Register every adapter, the settings section, and the route. Nothing here may throw: a
 * throwing loader row fails the whole plugin tree, so every optional surface degrades to a
 * `console.error` and lets the boot continue.
 *
 * @param ctx - plugin context; `web`, `settings`, `connection` and `webServer` are injected.
 * @param config - the loader row's config, used as the settings section's base layer.
 */
export function apply(ctx, config) {
  const entry = isRecord(config) ? config : {}
  let current = () => entry
  const read = () => current()

  // Both `inject` calls are wrapped, not just their bodies: registering an effect can itself
  // fail (a disposed context, an inactive effect), and either failure must degrade rather than
  // take the plugin tree down with it.
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        settingsCtx.settings.installSection(ctx, NS, Config, entry, {
          setSource: (source) => {
            current = typeof source === 'function' ? source : () => entry
          },
          onChange: () => {},
        })
      } catch (error) {
        console.error(`[web-search] settings section unavailable: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    console.error(`[web-search] settings injection failed: ${errorMessage(error)}`)
  }

  // Adapters are registered with a thunk so a settings change reaches the next request without
  // re-registering, which would make the seam's selection flicker.
  for (const adapter of ADAPTERS) {
    try {
      const register = adapter.kind === 'search' ? 'registerSearchProvider' : 'registerFetchProvider'
      ctx.effect(() => ctx.web[register](adapter.build(read)), `web-search: ${adapter.id}`)
    } catch (error) {
      console.error(`[web-search] ${adapter.kind} adapter ${adapter.id} registration failed: ${errorMessage(error)}`)
    }
  }

  try {
    ctx.inject(['connection', 'webServer'], (routeCtx) => {
      try {
        routeCtx.effect(
          () => routeCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler(routeCtx, read) }),
          'web-search: route',
        )
      } catch (error) {
        console.error(`[web-search] route registration failed: ${errorMessage(error)}`)
      }
    })
  } catch (error) {
    console.error(`[web-search] route injection failed: ${errorMessage(error)}`)
  }
}
