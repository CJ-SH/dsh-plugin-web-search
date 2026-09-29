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
//
// The fake models the REAL `slots.inject` contract: the callback runs only while the slot
// declaration is live (synchronously when it already exists), and its disposer runs when the
// declaration collapses. The previous fake invoked the callback unconditionally — that stub shape
// is exactly why a seat dsh 0.2 had renamed kept this suite green.

const locales = []

function makeHarness({ declared = [], localeLog = locales } = {}) {
  const seats = []
  const injectors = []
  const live = new Set(declared)
  const api = {
    declare(name) {
      if (live.has(name)) return
      live.add(name)
      for (const entry of injectors) {
        if (entry.key === name && entry.disposer === undefined) entry.disposer = entry.callback() ?? (() => {})
      }
    },
    collapse(name) {
      if (!live.has(name)) return
      live.delete(name)
      for (const entry of injectors) {
        if (entry.key !== name || entry.disposer === undefined) continue
        entry.disposer()
        entry.disposer = undefined
      }
    },
    cellsIn: (name) => seats.filter((seat) => seat.options.name === name),
  }
  const ctx = {
    slots: {
      inject: (key, callback) => {
        const entry = { key, callback, disposer: undefined }
        injectors.push(entry)
        if (live.has(key)) entry.disposer = callback() ?? (() => {})
        return () => {
          if (entry.disposer !== undefined) entry.disposer()
          entry.disposer = undefined
        }
      },
      register: (options, component) => {
        seats.push({ options, component })
        return () => {
          const index = seats.findIndex((seat) => seat.options === options)
          if (index >= 0) seats.splice(index, 1)
        }
      },
    },
    locale: {
      register: (ns, dictionaries) => {
        localeLog.push({ ns, dictionaries })
        return () => {}
      },
      getLocale: () => ({ active: 'zh' }),
    },
  }
  return { ctx, api, seats }
}

// `settings.section` must be declared for this plugin to have a seat to register into: it may not
// register into an undeclared slot (the shell throws, which fails the whole browser half).
const harness = makeHarness({ declared: ['settings.section'] })
let applyError = null
try {
  exported.apply(harness.ctx)
} catch (error) {
  applyError = error
}
check('apply: does not throw', applyError, null)
check('seat: without a hub, exactly one page is registered', harness.seats.length, 1)
check('seat: it is this plugin\'s own Settings page', harness.seats[0].options.name, 'settings.section')
check('seat: identified by the plugin id, not a namespace key', harness.seats[0].options.id, 'web-search')
check('seat: it carries no keyed `key` option', harness.seats[0].options.key, undefined)
check('seat: carries a locale for its copy', harness.seats[0].options.locale, 'web-search')
check('seat: its nav label resolves to a title', typeof harness.seats[0].options.label === 'function' ? harness.seats[0].options.label() : null, 'Web Search')
check('seat: registers a component', typeof harness.seats[0].component, 'function')

// ── one panel, two mount points (the hub swap) ──────────────────────────────────────────

const cardComponent = harness.seats[0].component

harness.api.declare('plugin-suite.panel')
check('hub: the own page stands down', harness.api.cellsIn('settings.section').length, 0)
check('hub: exactly one cell lands in the hub', harness.api.cellsIn('plugin-suite.panel').length, 1)
check('hub: the hub renders the very same component', harness.api.cellsIn('plugin-suite.panel')[0].component, cardComponent)

harness.api.collapse('plugin-suite.panel')
check('hub: collapsing the hub restores the own page', harness.api.cellsIn('settings.section').length, 1)
check('hub: and takes the hub cell away', harness.api.cellsIn('plugin-suite.panel').length, 0)

// A hub that was already composed when this plugin loaded must not leave two live entries: the
// `inject` callback runs synchronously in that case, which is why the standing page is registered
// BEFORE the injection is installed.
const hubFirst = makeHarness({ declared: ['settings.section', 'plugin-suite.panel'], localeLog: [] })
exported.apply(hubFirst.ctx)
check('hub: a hub loaded first still leaves exactly one cell',
  [hubFirst.api.cellsIn('settings.section').length, hubFirst.api.cellsIn('plugin-suite.panel').length], [0, 1])
check('locale: one namespace is registered', locales.map((entry) => entry.ns), ['web-search'])
check('locale: both dictionaries are supplied',
  Object.keys(locales[0].dictionaries).sort(), ['en', 'zh'])

const zhKeys = Object.keys(locales[0].dictionaries.zh).sort()
const enKeys = Object.keys(locales[0].dictionaries.en).sort()
check('locale: the dictionaries have identical key sets', zhKeys, enKeys)
check('locale: no dictionary entry is blank',
  Object.values(locales[0].dictionaries.zh).every((value) => typeof value === 'string' && value.length > 0), true)

// ── the seat this plugin cannot live without ────────────────────────────────────────────
//
// `settings.section` is declared by the settings shell, and registering into an UNDECLARED slot
// throws — which fails the entire browser half and surfaces as "did not activate" on a healthy
// workspace. That is exactly the bug this suite missed, because every harness above declares the
// seat. With none declared, `apply` must contribute nothing and must not throw.
const seatless = makeHarness({ localeLog: [] })
let seatlessError = null
try {
  exported.apply(seatless.ctx)
} catch (error) {
  seatlessError = error
}
check('seat: with no Settings seat declared, apply does not throw', seatlessError, null)
check('seat: and contributes nothing to an undeclared slot', seatless.seats.length, 0)

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
