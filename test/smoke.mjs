#!/usr/bin/env node
// 离线冒烟：不开 DSH，用桩件执行 client.js，验证
//   1) bundle 以正确 id 注册；2) 只注册一个槽位；3) 中英词典键一致；
//   4) 有 cwd 时渲染按钮、无 cwd 时不渲染。
//
// 用法（仓库根目录）：node test/smoke.mjs
// 说明：client.js 是 CJS 形态的 bundle（挂在 window.__ModuleLoader__ 上），而包是
// "type": "module"，所以这里用 vm 执行，不通过 import。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'client.js')

/** 断言；失败即退出，供 CI/手工回归使用。 */
function assert(condition, message) {
  if (!condition) {
    console.error('FAIL: ' + message)
    process.exit(1)
  }
}

/** 最小 React 桩件：只覆盖本插件实际调用的 API。 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue
        flat.push(child)
      }
      return { $$el: true, type, props: props || {}, children: flat }
    },
    Fragment: Symbol('Fragment'),
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() {},
    useRef(value) { return { current: value } },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
  }
}

/** 把元素树压成可断言的文本。 */
function toText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join(' ')
  const name = typeof node.type === 'function' ? (node.type.name || 'Component') : String(node.type)
  const own = toText(node.children)
  const aria = node.props['aria-label'] ? '[' + node.props['aria-label'] + ']' : ''
  const cls = node.props.className ? '.' + String(node.props.className).split(' ')[0] : ''
  return name + cls + aria + (own ? ' ' + own : '')
}

const registered = []
const sandbox = {
  window: { __ModuleLoader__: { load(entry) { registered.push(entry) } }, localStorage: { getItem: () => null, setItem: () => {} } },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {}, textContent: '' }),
    head: { appendChild() {} },
    body: {},
  },
  fetch: () => Promise.reject(new Error('no network in smoke test')),
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

assert(registered.length === 1, 'bundle 应只注册一次，实际 ' + String(registered.length))
const entry = registered[0]
assert(entry.id === '@local/dsh-open-in-app-dock', 'bundle id = ' + String(entry.id))

const plugin = entry.factory((name) => {
  if (name === 'react') return makeReact()
  if (name === 'react-dom') return { createPortal: (el) => ({ $$el: true, type: 'Portal', props: {}, children: [el] }) }
  throw new Error('unexpected require: ' + name)
})
assert(plugin.name === 'dsh-open-in-app-dock', 'plugin.name = ' + String(plugin.name))

let dicts = null
let slot = null
const effects = []
const ctx = {
  effect(fn, label) { effects.push(label); fn(); return fn },
  locale: {
    register(ns, table) { dicts = { ns, table }; return () => {} },
    bind() {
      return (key, values) => {
        let text = dicts.table.zh[key]
        if (text === undefined) return key
        if (values) for (const name of Object.keys(values)) text = text.replaceAll('{' + name + '}', values[name])
        return text
      }
    },
  },
  slots: {
    inject(name, cb) { cb() },
    register(options, component) { slot = { options, component }; return { dispose() {} } },
  },
}
plugin.apply(ctx)

assert(effects.length === 3, '应托管 3 个 effect，实际 ' + String(effects.length))
assert(dicts.ns === 'openInAppDock', 'locale ns = ' + String(dicts.ns))
const zhKeys = Object.keys(dicts.table.zh).sort()
const enKeys = Object.keys(dicts.table.en).sort()
assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英词典键必须一致')

assert(slot !== null, '必须注册槽位')
assert(slot.options.name === 'conversation.input.left', '槽位 = ' + String(slot.options.name))
assert(slot.options.locale === 'openInAppDock', '槽位必须绑定 locale 命名空间')

const t = ctx.locale.bind()
const Component = slot.component
const withCwd = Component({ sessionId: 's1', useSessions: (select) => select({ byId: { s1: { cwd: 'D:/demo' } } }), t })
assert(withCwd !== null, '有工作区时必须渲染')
const text = toText(withCwd)
assert(text.includes('dsod_btn'), '渲染结果应含按钮：' + text)
assert(text.includes('在应用中打开'), '按钮无障碍名缺失：' + text)
const withoutCwd = Component({ sessionId: 's1', useSessions: (select) => select({ byId: { s1: {} } }), t })
assert(withoutCwd === null, '没有工作区时不应渲染')

console.log('SMOKE OK — ' + String(zhKeys.length) + ' zh / ' + String(enKeys.length) + ' en keys, slot ' + slot.options.name)
