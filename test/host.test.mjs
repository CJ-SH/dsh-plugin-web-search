/**
 * Host-half self-check. Dependency-free: pure functions and adapters are asserted directly, the
 * fetch adapters run against a stubbed `fetch` so their real request shape is measured, and
 * `apply` runs against a hand-built cordis context stub so the no-throw contract is measured
 * rather than assumed.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

const packageDir = fileURLToPath(new URL('..', import.meta.url))

// A throwaway DSH_HOME keeps the patch-file assertions off the real ~/.dsh.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-web-search-'))
mkdirSync(join(sandbox, 'profiles', 'web'), { recursive: true })
process.env.DSH_HOME = sandbox

const m = await import('../lib/index.js')

// ── request URL (SearxNG format) ────────────────────────────────────────────────────────

check('url: appends the two documented parameters',
  m.buildRequestUrl('https://searx.example.org/search', 'deepseek harness'),
  'https://searx.example.org/search?q=deepseek%20harness&format=json')
check('url: never rewrites the path it was given',
  m.buildRequestUrl('https://example.org/prefix/custom-route', 'x'),
  'https://example.org/prefix/custom-route?q=x&format=json')
check('url: an existing query string is extended, not replaced',
  m.buildRequestUrl('https://example.org/search?engines=github', 'x'),
  'https://example.org/search?engines=github&q=x&format=json')
check('url: a trailing ? is not doubled',
  m.buildRequestUrl('https://example.org/search?', 'x'),
  'https://example.org/search?q=x&format=json')
check('url: the query is percent-encoded',
  m.buildRequestUrl('https://example.org/search', 'a&b=c'),
  'https://example.org/search?q=a%26b%3Dc&format=json')

// ── custom headers ──────────────────────────────────────────────────────────────────────

check('headers: empty input sends nothing', m.parseHeadersJson(''), { ok: true, headers: {}, dropped: [] })
check('headers: a valid object is passed through',
  m.parseHeadersJson('{"X-API-Key":"secret"}'), { ok: true, headers: { 'X-API-Key': 'secret' }, dropped: [] })
check('headers: an empty value means "send no header"',
  m.parseHeadersJson('{"X-Empty":""}'), { ok: true, headers: {}, dropped: [] })
check('headers: protocol-level names are dropped with a reason',
  m.parseHeadersJson('{"content-type":"text/plain","X-OK":"1"}'),
  { ok: true, headers: { 'X-OK': '1' }, dropped: ['content-type'] })
check('headers: a non-object is refused', m.parseHeadersJson('[1,2]').ok, false)
check('headers: a non-string value is refused', m.parseHeadersJson('{"X":1}').ok, false)
check('headers: malformed JSON is refused', m.parseHeadersJson('{oops}').ok, false)
check('headers: an adapter keeps its own authorization overridable',
  m.parseHeadersJson('{"authorization":"Bearer k"}').headers.authorization, 'Bearer k')

// ── adapter table ───────────────────────────────────────────────────────────────────────

check('adapters: every id is unique', new Set(m.ADAPTERS.map((a) => a.id)).size, m.ADAPTERS.length)
check('adapters: the search side ships one format', m.adaptersOf('search').map((a) => a.id), ['searxng'])
check('adapters: the fetch side ships two formats', m.adaptersOf('fetch').map((a) => a.id), ['jina', 'firecrawl'])
check('adapters: labels name a format, not a vendor', m.ADAPTERS.every((a) => a.labelKey.startsWith('adapter')), true)
check('adapters: a lookup by id resolves', m.adapterById('firecrawl').kind, 'fetch')
check('adapters: an unknown id resolves to nothing', m.adapterById('nope'), undefined)

// ── SearxNG decoding ────────────────────────────────────────────────────────────────────

check('map: a full entry maps every optional field',
  m.mapSearxngResponse({ results: [{ url: 'https://a/', title: 'A', content: 'snip', publishedDate: '2026-07-27T00:00:00' }] }),
  { sources: [{ url: 'https://a/', title: 'A', snippet: 'snip', publishedAt: '2026-07-27T00:00:00' }], truncated: false })
check('map: an entry without a URL is skipped, not repaired',
  m.mapSearxngResponse({ results: [{ title: 'no url' }, { url: '' }, { url: 'https://b/' }] }),
  { sources: [{ url: 'https://b/' }], truncated: false })
check('map: empty title and content omit their keys',
  m.mapSearxngResponse({ results: [{ url: 'https://c/', title: '', content: '' }] }),
  { sources: [{ url: 'https://c/' }], truncated: false })
check('map: a media result\'s extra fields are tolerated',
  m.mapSearxngResponse({ results: [{ url: 'https://f/', template: 'videos.html', audio_src: 'x' }] }),
  { sources: [{ url: 'https://f/' }], truncated: false })
check('map: a body without results yields an empty result, not an error',
  m.mapSearxngResponse({}), { sources: [], truncated: false })
check('map: truncated is always false — the seam owns the bound',
  m.mapSearxngResponse({ results: [{ url: 'https://g/' }] }).truncated, false)

// ── Jina format ─────────────────────────────────────────────────────────────────────────

check('jina: the target URL is appended to the endpoint path',
  m.buildJinaUrl('https://r.jina.ai', 'https://example.com/a'),
  'https://r.jina.ai/https://example.com/a')
check('jina: a base with a trailing slash does not double it',
  m.buildJinaUrl('https://fetch.747497.xyz/', 'https://example.com/a'),
  'https://fetch.747497.xyz/https://example.com/a')
check('jina: the target query string survives unencoded',
  m.buildJinaUrl('https://r.jina.ai', 'https://example.com/a?b=1&c=2'),
  'https://r.jina.ai/https://example.com/a?b=1&c=2')
check('jina: the structured envelope decodes',
  m.decodeJina({ code: 200, status: 20000, data: { title: 'T', url: 'https://e.com/', content: '# x', httpStatus: 200 } }, 200),
  { kind: 'text', content: '# x', url: 'https://e.com/', statusCode: 200, title: 'T' })
check('jina: a missing envelope degrades to empty content',
  m.decodeJina({}, 200), { kind: 'text', content: '', url: '', statusCode: 200, title: '' })
check('jina: the HTTP status stands in for a missing httpStatus',
  m.decodeJina({ data: { content: 'x' } }, 201).statusCode, 201)

// ── Firecrawl format ────────────────────────────────────────────────────────────────────

check('firecrawl: the request body names the markdown format',
  m.buildFirecrawlBody('https://example.com'), { url: 'https://example.com', formats: ['markdown'], onlyMainContent: true })
check('firecrawl: the scrape envelope decodes markdown',
  m.decodeFirecrawl({ success: true, data: { markdown: '# hi', metadata: { title: 'T', sourceURL: 'https://e.com/', statusCode: 200 } } }, 200),
  { kind: 'text', content: '# hi', url: 'https://e.com/', statusCode: 200, title: 'T', failure: '' })
check('firecrawl: html stands in when markdown is absent',
  m.decodeFirecrawl({ data: { html: '<p>hi</p>' } }, 200),
  { kind: 'html', content: '<p>hi</p>', url: '', statusCode: 200, title: '', failure: '' })
check('firecrawl: rawHtml is the last fallback',
  m.decodeFirecrawl({ data: { rawHtml: '<p>raw</p>' } }, 200).content, '<p>raw</p>')
check('firecrawl: success:false surfaces as a failure',
  m.decodeFirecrawl({ success: false, error: 'quota exceeded' }, 200).failure, 'quota exceeded')
check('firecrawl: a failure without a message still reports one',
  m.decodeFirecrawl({ success: false }, 200).failure, 'service reported success: false')

// ── the tolerance net ───────────────────────────────────────────────────────────────────

check('loose: content is found at the root', m.pickLooseText({ content: 'a' }), 'a')
check('loose: markdown is found under data', m.pickLooseText({ data: { markdown: 'b' } }), 'b')
check('loose: text is found at the root', m.pickLooseText({ text: 'c' }), 'c')
check('loose: an unrecognized body yields nothing', m.pickLooseText({ nope: 1 }), '')
check('shape: root keys are named', m.describeShape({ a: 1, b: 2 }), 'a, b')
check('shape: data keys are named with their prefix', m.describeShape({ data: { c: 1 } }), 'data, data.c')
check('shape: an empty body says so', m.describeShape({}), '(empty body)')

// ── the fetch adapters, against a stubbed fetch ─────────────────────────────────────────

const realFetch = globalThis.fetch
const calls = []
const respond = (payload, contentType) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }
}

const jinaProvider = m.adaptersOf('fetch').find((a) => a.id === 'jina')
const firecrawlProvider = m.adaptersOf('fetch').find((a) => a.id === 'firecrawl')
const sectionWith = (endpoint, headers = '') => ({ provider: 'searxng', fetchProvider: 'jina', providers: { jina: { endpoint, headers } } })

check('jina provider: unavailable while the endpoint is empty',
  jinaProvider.build(() => sectionWith('')).available(), false)
check('jina provider: available once the endpoint parses',
  jinaProvider.build(() => sectionWith('https://fetch.747497.xyz')).available(), true)
check('jina provider: an absent config slice reads as absent',
  jinaProvider.build(() => undefined).available(), false)

calls.length = 0
respond({ code: 200, data: { content: '# read', url: 'https://example.com/', httpStatus: 200 } }, 'application/json')
const jinaResult = await jinaProvider.build(() => sectionWith('https://fetch.747497.xyz', '{"X-API-Key":"k"}')).fetch({ url: 'https://example.com' }, undefined)
check('jina provider: dials the format URL', calls[0].url, 'https://fetch.747497.xyz/https://example.com')
check('jina provider: uses GET', calls[0].init.method, 'GET')
check('jina provider: asks for the envelope', calls[0].init.headers.accept, 'application/json')
check('jina provider: forwards the custom header', calls[0].init.headers['X-API-Key'], 'k')
check('jina provider: returns a text body', jinaResult, {
  url: 'https://example.com/', statusCode: 200, body: { kind: 'text', content: '# read' }, truncated: false,
})

calls.length = 0
respond('Title: Example\n\nplain markdown', 'text/plain; charset=utf-8')
const jinaText = await jinaProvider.build(() => sectionWith('https://fetch.747497.xyz')).fetch({ url: 'https://example.com' }, undefined)
check('jina provider: a plain-text answer is used verbatim', jinaText.body, { kind: 'text', content: 'Title: Example\n\nplain markdown' })
check('jina provider: the request URL is reported when the envelope omits one', jinaText.url, 'https://example.com')

calls.length = 0
respond({ success: true, data: { markdown: '# scraped', metadata: { sourceURL: 'https://example.com/', statusCode: 200, title: 'T' } } }, 'application/json')
const firecrawlResult = await firecrawlProvider
  .build(() => ({ provider: 'searxng', fetchProvider: 'firecrawl', providers: { firecrawl: { endpoint: 'https://api.firecrawl.dev/v2/scrape', headers: '' } } }))
  .fetch({ url: 'https://example.com' }, undefined)
check('firecrawl provider: dials the configured endpoint verbatim', calls[0].url, 'https://api.firecrawl.dev/v2/scrape')
check('firecrawl provider: uses POST', calls[0].init.method, 'POST')
check('firecrawl provider: sends the format body', JSON.parse(calls[0].init.body), { url: 'https://example.com', formats: ['markdown'], onlyMainContent: true })
check('firecrawl provider: declares JSON', calls[0].init.headers['content-type'], 'application/json')
check('firecrawl provider: returns the markdown as text', firecrawlResult.body, { kind: 'text', content: '# scraped' })
check('firecrawl provider: reports the resolved URL', firecrawlResult.url, 'https://example.com/')

calls.length = 0
respond({ success: true, data: { nope: true } }, 'application/json')
const looseFailure = await firecrawlProvider
  .build(() => ({ provider: 'searxng', fetchProvider: 'firecrawl', providers: { firecrawl: { endpoint: 'https://api.firecrawl.dev/v2/scrape', headers: '' } } }))
  .fetch({ url: 'https://example.com' }, undefined)
  .then(() => null, (error) => error)
check('firecrawl provider: an unrecognized body is refused', looseFailure?.code, 'WEB_PROVIDER_ERROR')
check('firecrawl provider: the refusal names the keys it saw, so the service can be adapted',
  looseFailure?.message.includes('data.nope'), true)

calls.length = 0
respond({ data: { nothing: true } }, 'application/json')
const jinaLoose = await jinaProvider
  .build(() => sectionWith('https://fetch.747497.xyz'))
  .fetch({ url: 'https://example.com' }, undefined)
  .then(() => null, (error) => error)
check('jina provider: an unrecognized envelope is refused', jinaLoose?.code, 'WEB_PROVIDER_ERROR')
check('jina provider: that refusal names the keys it saw', jinaLoose?.message.includes('data.nothing'), true)

globalThis.fetch = realFetch

// ── failure diagnostics ─────────────────────────────────────────────────────────────────

check('403 + cloudflare names the credential',
  m.classifyHttpFailure('X', 403, 'text/html', '<title>Attention Required! | Cloudflare</title>').includes('反向代理'), true)
check('403 + a bare forbidden names the format',
  m.classifyHttpFailure('X', 403, 'text/html', '<title>403 Forbidden</title>').includes('search.formats'), true)
check('429 names the limiter', m.classifyHttpFailure('X', 429, 'text/html', '').includes('限流'), true)
check('404 names the endpoint', m.classifyHttpFailure('X', 404, 'text/html', '').includes('端点不存在'), true)
check('html at another status names bot protection',
  m.classifyHttpFailure('X', 502, 'text/html', '').includes('bot'), true)

// ── patch file editing ──────────────────────────────────────────────────────────────────

const block = m.renderManagedBlock('searxng', 'http')
check('block: states both selection keys',
  block.includes('searchProvider: searxng') && block.includes('fetchProvider: http'), true)
check('block: carries both sentinels', block.startsWith('# >>>') && block.endsWith('<<<'), true)

const template = '# Your patch layer for this dsh profile.\n# a top-level YAML array.\n\n[]\n'
const withEmpty = m.upsertManagedBlock(template, block)
check('upsert: the [] placeholder is replaced, never appended to (invalid YAML otherwise)',
  withEmpty.includes('- id: web\n') && !withEmpty.includes('[]'), true)
check('upsert: the user\'s comments survive', withEmpty.includes('# Your patch layer'), true)

const userPatch = [
  '# my notes',
  '- id: web-ui-ssh',
  '  disabled: false',
  '- id: web',
  '  config:',
  '    searchProvider: ollama-cloud',
  '    fetchProvider: ollama-cloud',
  '',
].join('\n')
const appended = m.upsertManagedBlock(userPatch, block)
check('upsert: appends after existing entries', appended.trimEnd().endsWith('<<<'), true)
check('upsert: leaves every user line untouched',
  userPatch.split('\n').every((line) => line.length === 0 || appended.includes(line)), true)
check('upsert: is idempotent', m.upsertManagedBlock(appended, block) === appended, true)
check('upsert: stays idempotent across repeats',
  m.upsertManagedBlock(m.upsertManagedBlock(appended, block), block) === appended, true)
const reblocked = m.upsertManagedBlock(appended, m.renderManagedBlock('searxng', 'jina'))
check('upsert: a changed selection rewrites the block in place',
  reblocked.includes('fetchProvider: jina') && reblocked.split('# >>>').length === 2, true)
check('remove: the managed block is gone', m.removeManagedBlock(appended).includes('# >>>'), false)
check('remove: the user\'s own entry and notes remain',
  m.removeManagedBlock(appended).includes('# my notes') && m.removeManagedBlock(appended).includes('searchProvider: ollama-cloud'), true)
check('remove: is a no-op on a file without a block', m.removeManagedBlock(userPatch), userPatch)

// ── what a patch layer currently states ─────────────────────────────────────────────────

check('detect: reads fetchProvider out of the web entry', m.readWebEntryFetchProvider(userPatch), 'ollama-cloud')
check('detect: reads searchProvider out of the web entry', m.readWebEntrySearchProvider(userPatch), 'ollama-cloud')
check('detect: quoted values are unquoted', m.readWebEntryFetchProvider("- id: web\n  config:\n    fetchProvider: 'http'\n"), 'http')
check('detect: stops at the next entry',
  m.readWebEntryFetchProvider('- id: web\n  config:\n    searchProvider: x\n- id: other\n  fetchProvider: nope\n'), undefined)
check('detect: an unrelated entry yields nothing',
  m.readWebEntryFetchProvider('- id: web-ui-ssh\n  config:\n    fetchProvider: nope\n'), undefined)
check('detect: falls back to the in-box provider', m.detectFetchProvider(), 'http')

// ── save-request validation ─────────────────────────────────────────────────────────────

const save = (search, fetch) => m.parseSaveRequest({ search, fetch })
check('save: accepts both selections',
  save({ provider: 'searxng', endpoint: 'https://s.example/search', headers: '' }, { provider: 'http' }).ok, true)
check('save: collects configuration only for adapters this plugin owns',
  save({ provider: 'searxng', endpoint: 'https://s.example/search', headers: '' }, { provider: 'http' }).contributions,
  [['searxng', { endpoint: 'https://s.example/search', headers: '' }]])
check('save: a foreign provider contributes no configuration',
  save({ provider: 'deepseek-official' }, { provider: 'http' }).contributions, [])
check('save: a blank selection falls back to the shipped default',
  save({}, {}).search, 'searxng')
check('save: both sides may contribute',
  save({ provider: 'searxng', endpoint: 'https://s.example/search' }, { provider: 'jina', endpoint: 'https://f.example' }).contributions.length, 2)
check('save: refuses a malformed search endpoint', save({ provider: 'searxng', endpoint: 'not a url' }, { provider: 'http' }).ok, false)
check('save: refuses a malformed fetch endpoint', save({ provider: 'searxng' }, { provider: 'jina', endpoint: 'nope' }).ok, false)
check('save: refuses malformed header JSON', save({ provider: 'searxng', headers: '{oops}' }, { provider: 'http' }).ok, false)
check('save: a blank endpoint is allowed (unconfigured, not invalid)',
  save({ provider: 'searxng', endpoint: '' }, { provider: 'http' }).ok, true)

check('merge: the edited adapter is replaced',
  m.mergeAdapterConfigs({ providers: { searxng: { endpoint: 'old', headers: '' } } }, [['searxng', { endpoint: 'new', headers: '{}' }]]),
  { searxng: { endpoint: 'new', headers: '{}' } })
check('merge: an untouched adapter is preserved',
  m.mergeAdapterConfigs(
    { providers: { searxng: { endpoint: 's', headers: '' }, jina: { endpoint: 'j', headers: '' } } },
    [['searxng', { endpoint: 's2', headers: '' }]],
  ),
  { searxng: { endpoint: 's2', headers: '' }, jina: { endpoint: 'j', headers: '' } })
check('merge: a section without providers starts empty', m.mergeAdapterConfigs({}, []), {})

// ── settings schema ─────────────────────────────────────────────────────────────────────

check('schema: defaults resolve for an empty section',
  m.Config({}), { provider: 'searxng', fetchProvider: 'http', providers: {} })
check('schema: an adapter config round-trips across both capabilities',
  m.Config({ providers: { searxng: { endpoint: 'https://s/' }, jina: { endpoint: 'https://j/' } } }).providers.jina.endpoint,
  'https://j/')
check('schema: serializes for the configuration surface', typeof m.Config.toJSON(), 'object')

// ── listing what the seam actually registered ───────────────────────────────────────────

const withRegistry = { get: () => ({ searchProviders: new Map([['searxng', {}], ['deepseek-official', {}]]), fetchProviders: new Map([['http', {}]]) }) }
check('registry: search ids are listed', m.listRegisteredProviders(withRegistry, 'search'), ['deepseek-official', 'searxng'])
check('registry: fetch ids are listed', m.listRegisteredProviders(withRegistry, 'fetch'), ['http'])
check('registry: a missing service degrades to an empty list', m.listRegisteredProviders({ get: () => undefined }, 'fetch'), [])
check('registry: a non-Map registry degrades to an empty list', m.listRegisteredProviders({ get: () => ({ fetchProviders: undefined }) }, 'fetch'), [])
check('registry: a throwing read degrades to an empty list',
  m.listRegisteredProviders({ get: () => { throw new Error('nope') } }, 'fetch'), [])

// ── packaging contract ──────────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
check('manifest: the bundle id is the package name', manifest.name, 'dsh-plugin-web-search')
check('manifest: the loader patch is declared', manifest.dsh.bundle.patch, './cordis.patch.yml')
check('manifest: the browser half is exported', manifest.exports['./client'], './lib/client.js')
check('manifest: both halves ship', manifest.files.includes('lib'), true)
check('manifest: the peer imports are declared', Object.keys(manifest.peerDependencies).sort(),
  ['@deepseek-ai/dsh-web', '@deepseek-ai/schemastery'])

const patchText = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
check('patch: inserts exactly the plugin row',
  /- insert:\s*\n\s*- id: web-search\s*\n\s*name: 'dsh-plugin-web-search'/.test(patchText), true)
check('patch: widens no shipped row', patchText.includes('- id: connection'), false)

const hostSource = readFileSync(join(packageDir, 'lib', 'index.js'), 'utf8')
const specifiers = [...hostSource.matchAll(/from '([^']+)'/g)].map((match) => match[1]).filter((s) => s.startsWith('@'))
check('host half: imports only the seam and the schema factory', [...new Set(specifiers)].sort(),
  ['@deepseek-ai/dsh-web', '@deepseek-ai/schemastery'])
check('host half: declares web first', m.inject[0], 'web')

// ── apply must not throw ────────────────────────────────────────────────────────────────

function fakeContext() {
  const registered = { search: [], fetch: [], routes: [], sections: [] }
  const registry = { searchProviders: new Map(), fetchProviders: new Map() }
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject: (deps, callback) => {
      callback({
        effect: ctx.effect,
        get: () => undefined,
        settings: {
          installSection: (owner, ns, schema, entry, hooks) => {
            registered.sections.push(ns)
            hooks.setSource(() => entry)
          },
        },
        webServer: {
          register: (route) => {
            registered.routes.push(route)
            return () => {}
          },
        },
        web: {
          registerSearchProvider: (provider) => {
            registered.search.push(provider)
            return () => {}
          },
          registerFetchProvider: (provider) => {
            registered.fetch.push(provider)
            return () => {}
          },
        },
      })
    },
    get: () => undefined,
    web: {
      registerSearchProvider: (provider) => {
        registered.search.push(provider)
        return () => {}
      },
      registerFetchProvider: (provider) => {
        registered.fetch.push(provider)
        return () => {}
      },
    },
  }
  void registry
  return { ctx, registered }
}

const applied = fakeContext()
let applyError = null
try {
  m.apply(applied.ctx, {})
} catch (error) {
  applyError = error
}
check('apply: does not throw on a well-formed context', applyError, null)
check('apply: registers the search adapter', applied.registered.search.map((p) => p.id), ['searxng'])
check('apply: registers both fetch adapters', applied.registered.fetch.map((p) => p.id), ['jina', 'firecrawl'])
check('apply: registers the settings section', applied.registered.sections, ['web-search'])
check('apply: owns a prefix route, not a channel',
  applied.registered.routes.map((route) => route.kind + ' ' + route.path), ['prefix /web-search'])
check('apply: the route handler is callable', typeof applied.registered.routes[0].handler, 'function')

const realConsoleError = console.error
console.error = () => {}
const broken = fakeContext()
broken.ctx.web = {
  registerSearchProvider: () => { throw new Error('duplicate id') },
  registerFetchProvider: () => { throw new Error('duplicate id') },
}
broken.ctx.inject = (deps, callback) => {
  if (deps.includes('settings')) throw new Error('no settings provider')
  callback(broken.ctx)
}
let brokenError = null
try {
  m.apply(broken.ctx, {})
} catch (error) {
  brokenError = error
}
check('apply: degrades instead of throwing when a surface is unavailable', brokenError, null)
console.error = realConsoleError

rmSync(sandbox, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
for (const entry of failed) {
  console.log('FAIL  ' + entry.label)
  console.log('      actual:   ' + JSON.stringify(entry.actual))
  console.log('      expected: ' + JSON.stringify(entry.expected))
}
console.log(`host: ${results.length - failed.length}/${results.length} assertions passed`)
process.exitCode = failed.length === 0 ? 0 : 1
