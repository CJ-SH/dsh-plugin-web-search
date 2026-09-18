/**
 * Configuration-card self-check. Dependency-free: a minimal hook runtime stands in for React, so
 * the card's real behaviour — the collapsible shell, the two provider selections, the read,
 * staging, saving — is exercised without a browser or a test framework.
 */
const results = []
const check = (label, actual, expected) => {
  results.push({ label, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected })
}

// ── minimal hook runtime ────────────────────────────────────────────────────────────────

let runtime = null

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function makeRuntime() {
  const slots = []
  let cursor = 0
  let pending = []
  return {
    begin() {
      cursor = 0
      pending = []
    },
    take() {
      const ready = pending
      pending = []
      return ready
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (slots[index] === undefined) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) {
        slots[index] = { value: fn, deps }
        return fn
      }
      return slot.value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const slot = slots[index]
      const first = slot === undefined || !sameDeps(slot.deps, deps)
      if (!first) return
      slots[index] = { deps, ran: true }
      pending.push(fn)
    },
  }
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => runtime.useState(initial),
  useEffect: (fn, deps) => runtime.useEffect(fn, deps),
  useCallback: (fn, deps) => runtime.useCallback(fn, deps),
}

// ── shell bootstrap ─────────────────────────────────────────────────────────────────────

let registration = null
globalThis.window = { __ModuleLoader__: { load: (value) => { registration = value } } }

await import('../lib/client.js')

const seats = []
const exported = registration.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error('unexpected require: ' + specifier)
})
exported.apply({
  slots: { inject: (key, callback) => callback(), register: (options, component) => { seats.push({ options, component }); return () => {} } },
  locale: { register: () => () => {} },
})
const Card = seats[0].component

// ── host stub ───────────────────────────────────────────────────────────────────────────

const hostState = {
  adapters: [
    { id: 'searxng', kind: 'search', labelKey: 'adapterSearxng', endpoint: 'https://searx.example.org/search', headers: '{"X-API-Key":"k"}' },
    { id: 'jina', kind: 'fetch', labelKey: 'adapterJina', endpoint: '', headers: '' },
    { id: 'firecrawl', kind: 'fetch', labelKey: 'adapterFirecrawl', endpoint: '', headers: '' },
  ],
  selected: { search: 'searxng', fetch: 'http' },
  registered: { search: ['searxng', 'deepseek-official'], fetch: ['http', 'jina', 'firecrawl', 'ollama-cloud'] },
  detectedFetchProvider: 'http',
  takeover: { active: false, path: 'C:/Users/example/.dsh/cordis.patch.yml' },
}

const calls = []
// The stub applies a save rather than echoing a frozen snapshot: the card collapses only after the
// read-back confirms the write, so a stub that ignored the payload would test a flow no host has.
const mutable = JSON.parse(JSON.stringify(hostState))
function applySave(payload) {
  mutable.selected = { search: payload.search.provider, fetch: payload.fetch.provider }
  for (const entry of mutable.adapters) {
    const side = entry.kind === 'search' ? payload.search : payload.fetch
    if (side.provider === entry.id) {
      entry.endpoint = side.endpoint
      entry.headers = side.headers
    }
  }
}
globalThis.fetch = async (url, options) => {
  const path = new URL(String(url)).pathname
  calls.push({ path, method: options?.method, body: options?.body })
  if (path.endsWith('/config/save')) applySave(JSON.parse(options.body))
  return { ok: true, status: 200, json: async () => ({ ok: true, value: mutable }) }
}

// ── render driver ───────────────────────────────────────────────────────────────────────

async function render(component, props) {
  runtime.begin()
  const tree = component(props)
  const effects = runtime.take()
  for (const fn of effects) fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return tree
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && node.props !== undefined) return textOf(node.props.children)
  return ''
}

function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (node.props !== undefined) {
    if (predicate(node)) found.push(node)
    findAll(node.props.children, predicate, found)
  }
  return found
}

const headerButton = (tree) =>
  findAll(tree, (node) => node.type === 'button' && String(node.props.className ?? '').includes('-cardheader'))[0]
const buttonByText = (tree, label) =>
  findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === label)[0]
const selects = (tree) => findAll(tree, (node) => node.type === 'select')
const inputs = (tree) => findAll(tree, (node) => node.type === 'input')
const textareas = (tree) => findAll(tree, (node) => node.type === 'textarea')
const optionLabels = (select) => findAll(select, (node) => node.type === 'option').map((node) => textOf(node).trim())

// ── the shell: collapsed by default ─────────────────────────────────────────────────────

runtime = makeRuntime()
runtime.begin()
const firstPaint = Card({})
check('shell: the card is a list item', firstPaint.type, 'li')
check('shell: the first paint is collapsed', firstPaint.props['data-open'], 'false')
check('shell: the header is a disclosure button', headerButton(firstPaint).props['aria-expanded'], 'false')
check('shell: the title is on the header', textOf(firstPaint).includes('Web Search'), true)
check('shell: a collapsed card renders no fields', inputs(firstPaint).length + selects(firstPaint).length, 0)
check('shell: a collapsed card renders no loading text', textOf(firstPaint).includes('正在读取配置'), false)
runtime.take()

// ── expanding reveals both selections ───────────────────────────────────────────────────

runtime = makeRuntime()
calls.length = 0
let tree = await render(Card, {})
tree = await render(Card, {})
check('read: the read happens while collapsed', calls.length >= 1, true)

headerButton(tree).props.onClick()
tree = await render(Card, {})
tree = await render(Card, {})

check('shell: expanding flips the disclosure', tree.props['data-open'], 'true')
check('read: the read is a POST to the state endpoint', calls[0].path + ' ' + calls[0].method, '/web-search/state/read POST')
check('read: the body is JSON, never omitted', calls[0].body, '{}')
check('selects: the card offers a search and a fetch selection', selects(tree).length, 2)
check('selects: the search side names the FORMAT, not the vendor',
  optionLabels(selects(tree)[0]), ['兼容 SearxNG 格式', 'deepseek-official'])
check('selects: the fetch side offers the in-box provider and both formats',
  optionLabels(selects(tree)[1]), ['兼容 Jina 格式', '兼容 Firecrawl 格式', '内置 http（本机抓取）', 'ollama-cloud'])
check('selects: the stored selections are staged', selects(tree).map((node) => node.props.value), ['searxng', 'http'])
check('fields: the search adapter shows its stored endpoint', inputs(tree)[0].props.value, 'https://searx.example.org/search')
check('fields: the search adapter shows its stored headers', textareas(tree)[0].props.value, '{"X-API-Key":"k"}')
check('fields: the in-box fetch provider carries no configuration here',
  textOf(tree).includes('由其它插件注册'), true)
check('fields: the search endpoint hint is format-specific',
  textOf(tree).includes('不补路径、不去尾斜线') || textOf(tree).includes('不补路径、不去尾斜杠'), true)
check('shell: the header reports it has not taken over', textOf(tree).includes('未接管'), true)
check('shell: the managed file is named', textOf(tree).includes('C:/Users/example/.dsh/cordis.patch.yml'), true)
check('shell: save is disabled while nothing changed', buttonByText(tree, '保存').props.disabled, true)

// ── switching the fetch side to a format reveals its fields ─────────────────────────────

selects(tree)[1].props.onChange({ target: { value: 'jina' } })
tree = await render(Card, {})
check('selects: switching to a format re-stages that format\'s configuration',
  selects(tree).map((node) => node.props.value), ['searxng', 'jina'])
check('fields: the new format contributes its own endpoint and headers',
  inputs(tree).length, 2)
check('fields: an unconfigured format says so rather than looking ready',
  textOf(tree).includes('该格式尚未填写端点'), true)
check('fields: the Jina hint explains that it is a prefix',
  textOf(tree).includes('拼在你填的地址之后'), true)
check('shell: a selection change marks the card unsaved', textOf(tree).includes('未保存'), true)
check('shell: a selection change enables save', buttonByText(tree, '保存').props.disabled, false)

// ── saving ──────────────────────────────────────────────────────────────────────────────

inputs(tree)[1].props.onChange({ target: { value: 'https://fetch.747497.xyz' } })
tree = await render(Card, {})
await buttonByText(tree, '保存').props.onClick()
tree = await render(Card, {})
tree = await render(Card, {})
check('save: posts to the save endpoint', calls[calls.length - 1].path, '/web-search/config/save')
check('save: the payload carries BOTH sides', JSON.parse(calls[calls.length - 1].body), {
  search: { provider: 'searxng', endpoint: 'https://searx.example.org/search', headers: '{"X-API-Key":"k"}' },
  fetch: { provider: 'jina', endpoint: 'https://fetch.747497.xyz', headers: '' },
})
check('save: a confirmed save collapses the card again', tree.props['data-open'], 'false')

// ── an invalid draft never reaches the host ─────────────────────────────────────────────

headerButton(tree).props.onClick()
tree = await render(Card, {})
textareas(tree)[1].props.onChange({ target: { value: '{oops}' } })
tree = await render(Card, {})
check('draft: an invalid fetch-header draft is reported', textOf(tree).includes('不是合法的 JSON 对象'), true)
const before = calls.length
await buttonByText(tree, '保存').props.onClick()
tree = await render(Card, {})
check('draft: an invalid draft never reaches the host', calls.length, before)

// ── selecting a foreign provider ────────────────────────────────────────────────────────

selects(tree)[1].props.onChange({ target: { value: 'ollama-cloud' } })
tree = await render(Card, {})
check('selects: a foreign provider is selectable', selects(tree)[1].props.value, 'ollama-cloud')
check('selects: a foreign provider defers to its own configuration page',
  textOf(tree).includes('由其它插件注册'), true)
check('selects: a foreign provider contributes no endpoint field here', inputs(tree).length, 1)

// ── restore drives its own endpoint ─────────────────────────────────────────────────────

await buttonByText(tree, '还原为默认').props.onClick()
tree = await render(Card, {})
check('restore: posts to the restore endpoint', calls[calls.length - 1].path, '/web-search/takeover/restore')

// ── failure path ────────────────────────────────────────────────────────────────────────

globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ ok: false, error: { code: 'settings-unavailable', message: 'no settings provider is mounted' } }),
})
runtime = makeRuntime()
for (let pass = 0; pass < 4; pass += 1) tree = await render(Card, {})
check('failure: a refused read reveals the card instead of hiding it', tree.props['data-open'], 'true')
check('failure: the host\'s message is shown', textOf(tree).includes('no settings provider is mounted'), true)
check('failure: a retry is offered', buttonByText(tree, '重试') !== undefined, true)

const failed = results.filter((entry) => !entry.ok)
for (const entry of failed) {
  console.log('FAIL  ' + entry.label)
  console.log('      actual:   ' + JSON.stringify(entry.actual))
  console.log('      expected: ' + JSON.stringify(entry.expected))
}
console.log(`card: ${results.length - failed.length}/${results.length} assertions passed`)
process.exitCode = failed.length === 0 ? 0 : 1
