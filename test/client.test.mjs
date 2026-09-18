/**
 * Browser-half self-check. Dependency-free: a fake module loader and a React stub stand in for
 * the shell, so the packaging contract and the seat registration are measured without a browser.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

/** Every specifier the bundle asked the module loader for. */
const requested = []

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** The registration handed to the shell's loader. */
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      registration = value
    },
  },
}

await import('../lib/client.js')

check('bundle: the loader was called exactly once', registration === null, false)
check('bundle: id equals the package name', registration.id, manifest.name)
check('bundle: the factory is callable', typeof registration.factory, 'function')

const exported = registration.factory((specifier) => {
  requested.push(specifier)
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require: ${specifier}`)
})

check('bundle: requires only react', requested, ['react'])
check('bundle: exports apply', typeof exported.apply, 'function')
check('bundle: exports inject', Array.isArray(exported.inject), true)
check('bundle: declares the slots service it reads', exported.inject.includes('slots'), true)
check('bundle: declares the locale service it reads', exported.inject.includes('locale'), true)
check('bundle: does not depend on the connection client', exported.inject.includes('connection'), false)

// ── seat registration ───────────────────────────────────────────────────────────────────

const seats = []
const locales = []
const ctx = {
  slots: {
    inject: (key, callback) => {
      callback()
    },
    register: (options, component) => {
      seats.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register: (ns, dictionaries) => {
      locales.push({ ns, dictionaries })
      return () => {}
    },
  },
}

let applyError = null
try {
  exported.apply(ctx)
} catch (error) {
  applyError = error
}
check('apply: does not throw', applyError, null)
check('seat: exactly one cell is registered', seats.length, 1)
check('seat: joins the plugin configuration seat', seats[0].options.name, 'settings.plugin.item')
check('seat: keyed by the settings namespace', seats[0].options.key, 'web-search')
check('seat: carries a locale for its copy', seats[0].options.locale, 'web-search')
check('seat: registers a component', typeof seats[0].component, 'function')
check('locale: one namespace is registered', locales.map((entry) => entry.ns), ['web-search'])
check('locale: both dictionaries are supplied',
  Object.keys(locales[0].dictionaries).sort(), ['en', 'zh'])

const zhKeys = Object.keys(locales[0].dictionaries.zh).sort()
const enKeys = Object.keys(locales[0].dictionaries.en).sort()
check('locale: the dictionaries have identical key sets', zhKeys, enKeys)
check('locale: no dictionary entry is blank',
  Object.values(locales[0].dictionaries.zh).every((value) => typeof value === 'string' && value.length > 0), true)

// ── a loader-less composition still renders ─────────────────────────────────────────────

const bare = {
  slots: { inject: (key, callback) => callback(), register: () => () => {} },
}
let bareError = null
try {
  exported.apply(bare)
} catch (error) {
  bareError = error
}
check('apply: survives a composition without the locale seam', bareError, null)

// ── cross-half constant agreement ───────────────────────────────────────────────────────
// The host and browser halves duplicate the route prefix, the namespace and the endpoint
// names on purpose; a rename in one file must fail here rather than at runtime.

const hostSource = readFileSync(join(packageDir, 'lib', 'index.js'), 'utf8')
const clientSource = readFileSync(join(packageDir, 'lib', 'client.js'), 'utf8')

// The two halves duplicate the route prefix, the namespace, the endpoint names, the in-box
// fetch provider id, and the fetch FORMAT ids the card branches its endpoint hints on.
for (const literal of [
  "'/web-search'",
  "'web-search'",
  "'state/read'",
  "'config/save'",
  "'takeover/restore'",
  "'http'",
  "'jina'",
  "'firecrawl'",
]) {
  check(`halves agree on ${literal}`, hostSource.includes(literal) && clientSource.includes(literal), true)
}

// Every adapter label the card can render must exist in BOTH dictionaries.
const hostSourceForLabels = readFileSync(join(packageDir, 'lib', 'index.js'), 'utf8')
const labelKeys = [...hostSourceForLabels.matchAll(/labelKey: '([^']+)'/g)].map((match) => match[1])
check('labels: the host declares one label key per adapter', labelKeys.sort(), ['adapterFirecrawl', 'adapterJina', 'adapterSearxng'])
check('labels: every adapter label is in the zh dictionary',
  labelKeys.every((key) => Object.prototype.hasOwnProperty.call(locales[0].dictionaries.zh, key)), true)
check('labels: every adapter label is in the en dictionary',
  labelKeys.every((key) => Object.prototype.hasOwnProperty.call(locales[0].dictionaries.en, key)), true)
check('labels: the in-box fetch provider has copy too',
  Object.prototype.hasOwnProperty.call(locales[0].dictionaries.zh, 'builtinFetch'), true)

const failed = results.filter((entry) => !entry.ok)
for (const entry of failed) {
  console.log('FAIL  ' + entry.label)
  console.log('      actual:   ' + JSON.stringify(entry.actual))
  console.log('      expected: ' + JSON.stringify(entry.expected))
}
console.log(`client: ${results.length - failed.length}/${results.length} assertions passed`)
process.exitCode = failed.length === 0 ? 0 : 1
