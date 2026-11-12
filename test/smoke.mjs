#!/usr/bin/env node
// 离线冒烟：不开 DSH，用桩件执行 client.js，验证
//   1) bundle 以正确 id 注册；2) 注册三个座位（右上角 / 底栏 / 设置行）；
//   3) 中英词典键一致；4) 位置偏好驱动「在哪渲染」；
//   5) 有 cwd 时渲染按钮、无 cwd 时不渲染。
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

/**
 * 把元素树压成可断言的文本。函数组件会被真正调用一次再展开，
 * 这样「位置在哪渲染」这类判断看到的是最终输出而不是组件名。
 * depth 只用于防止写错时的无限递归。
 */
function toText(node, depth = 0) {
  if (depth > 12) return '<max-depth>'
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'function') return toText(node({}), depth + 1)
  if (Array.isArray(node)) return node.map((child) => toText(child, depth + 1)).join(' ')
  const { type, props, children } = node
  const own = toText(children, depth + 1)
  const aria = props['aria-label'] ? '[' + props['aria-label'] + ']' : ''
  if (typeof type === 'function') {
    // 组件：调用一次拿到真实输出（桩件下的 hooks 每次返回初始值，足以断言渲染分支）。
    return toText(type(props), depth + 1)
  }
  const cls = props.className ? '.' + String(props.className).split(' ')[0] : ''
  return String(type) + cls + aria + (own ? ' ' + own : '')
}

const store = new Map()
const registered = []
const sandbox = {
  window: {
    __ModuleLoader__: { load(entry) { registered.push(entry) } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
    },
  },
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
const slots = new Map()
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
    register(options, component) { slots.set(options.name, { options, component }); return { dispose() {} } },
  },
}
plugin.apply(ctx)

assert(effects.length === 3, '应托管 3 个 effect，实际 ' + String(effects.length))
assert(dicts.ns === 'openInAppDock', 'locale ns = ' + String(dicts.ns))
const zhKeys = Object.keys(dicts.table.zh).sort()
const enKeys = Object.keys(dicts.table.en).sort()
assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英词典键必须一致')

for (const name of ['conversation.session.header.utilities', 'conversation.input.left', 'settings.general.item']) {
  assert(slots.has(name), '缺少座位注册：' + name)
  assert(slots.get(name).options.locale === 'openInAppDock', name + ' 必须绑定 locale 命名空间')
}
assert(slots.get('conversation.session.header.utilities').options.order < 0, '右上角按钮应在 ⋯ 菜单（order 0）左侧')

const t = ctx.locale.bind()
const header = slots.get('conversation.session.header.utilities').component
const composer = slots.get('conversation.input.left').component
const settings = slots.get('settings.general.item').component
const withCwd = { sessionId: 's1', useSessions: (select) => select({ byId: { s1: { cwd: 'D:/demo' } } }), t }
const noCwd = { sessionId: 's1', useSessions: (select) => select({ byId: { s1: {} } }), t }

/**
 * 展开组件链，返回它最终是否真的画出了东西。
 * 座位出口是 display:contents，组件返回 null 等于「这个位置没有控件」，
 * 所以「是否渲染」必须按展开后的输出判断，而不是看外层包装组件的返回值。
 */
function rendered(component, props) {
  return toText(component(props)).trim()
}

// 默认位置是右上角：只有 header 座位渲染。
assert(store.get('dsh-open-in-app-dock:position') === undefined, '首装不应预写偏好')
const headerDefault = rendered(header, withCwd)
assert(headerDefault !== '', '默认（右上角）应在 header 座位渲染')
assert(headerDefault.includes('在应用中打开'), '按钮无障碍名缺失：' + headerDefault)
assert(rendered(composer, withCwd) === '', '默认位置下底栏座位不应渲染')

// 切到底栏：反转。
const api = sandbox.window.__dshOpenInAppDock
assert(typeof api?.setPosition === 'function', '缺少 setPosition 调试接口')
api.setPosition('composer')
assert(store.get('dsh-open-in-app-dock:position') === 'composer', '偏好应写入 localStorage')
assert(rendered(header, withCwd) === '', '切到底栏后 header 座位不应渲染')
assert(rendered(composer, withCwd) !== '', '切到底栏后 composer 座位应渲染')

// 隐藏：两个座位都不渲染，但设置行仍在。
api.setPosition('hidden')
assert(rendered(header, withCwd) === '', '隐藏后 header 不应渲染')
assert(rendered(composer, withCwd) === '', '隐藏后 composer 不应渲染')

// 没有工作区时任何位置都不渲染。
api.setPosition('header')
assert(rendered(header, noCwd) === '', '没有工作区时不应渲染')

// 设置行：与位置无关，始终渲染，且三个选项齐全。
const rowText = rendered(settings, { t })
assert(rowText !== '', '设置行必须渲染')
for (const label of ['右上角', '底栏左侧', '隐藏']) {
  assert(rowText.includes(label), '设置行缺少选项 ' + label + '：' + rowText)
}

// 非法偏好回落到默认。
api.setPosition('nonsense')
assert(sandbox.window.__dshOpenInAppDock.position() === 'header', '非法位置应保持不变')

console.log('SMOKE OK — ' + String(zhKeys.length) + ' zh / ' + String(enKeys.length) + ' en keys, '
  + String(slots.size) + ' slots: ' + [...slots.keys()].join(', '))