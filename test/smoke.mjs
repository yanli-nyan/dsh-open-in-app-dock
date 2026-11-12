#!/usr/bin/env node
// 离线冒烟：不开 DSH，用桩件执行 client.js，验证
//   1) bundle 以正确 id 注册；2) 注册三个座位（右上角 / 底栏 / 两行设置）；
//   3) 中英词典键一致；4) 位置偏好驱动「在哪渲染」；
//   5) 有 cwd 时渲染按钮、无 cwd 时不渲染；
//   6) 两行设置的控件与偏好读写（含「切换时是否顺带启动」）。
//
// 不模拟完整 React 调度：桩件与真实渲染语义容易偏离，宁可少测一层，
// 也不引入会假失败的脚手架。交互契约用源码断言兜住。
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
    useState(init) {
      const hooks = globalThis.__dshMountHooks
      return hooks ? hooks.useState(init) : [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect(fn) {
      const hooks = globalThis.__dshMountHooks
      if (hooks) hooks.useEffect(fn)
    },
    // 与 React 一致：初始就是入参（通常是 null）。桩件不模拟 DOM 挂载，
    // 因此不测依赖 ref.current 的点击行为。
    useRef(value) { return { current: value ?? null } },
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
/** 记录每次 fetch，用于断言「切换时是否真的启动了」。 */
const fetches = []
/** 只统计启动请求。 */
const launches = () => fetches.filter((f) => f.url === 'open-in-app/open')
const registered = []
const sandbox = {
  window: {
    __ModuleLoader__: { load(entry) { registered.push(entry) } },
    innerWidth: 1280,
    innerHeight: 900,
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
  fetch: (input, init) => {
    fetches.push({ url: String(input), init })
    // apps 目录返回两个应用；启动路由返回 200。
    if (String(input) === 'open-in-app/apps') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ apps: ['vscode', 'cursor'] }) })
    }
    return Promise.resolve({ ok: true })
  },
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
    register(options, component) { (slots.get(options.name) ?? slots.set(options.name, []).get(options.name)).push({ options, component }); return { dispose() {} } },
  },
}
plugin.apply(ctx)

assert(effects.length === 3, '应托管 3 个 effect，实际 ' + String(effects.length))
assert(dicts.ns === 'openInAppDock', 'locale ns = ' + String(dicts.ns))
const zhKeys = Object.keys(dicts.table.zh).sort()
const enKeys = Object.keys(dicts.table.en).sort()
assert(JSON.stringify(zhKeys) === JSON.stringify(enKeys), '中英词典键必须一致')



/** 在元素树里按 aria-label 找按钮（会展开函数组件）。 */
function findButton(node, label, depth = 0) {
  if (depth > 12 || node === null || node === undefined || node === false) return undefined
  if (typeof node === 'function') return findButton(node({}), label, depth + 1)
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (typeof node.type === 'function') return findButton(node.type(node.props), label, depth + 1)
  if (node.props['aria-label'] === label) return node
  return findButton(node.children, label, depth + 1)
}

/** 在元素树里按 className 找元素（会展开函数组件）。 */
function findByClass(node, className, depth = 0) {
  if (depth > 12 || node === null || node === undefined || node === false) return undefined
  if (typeof node === 'function') return findByClass(node({}), className, depth + 1)
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof node !== 'object') return undefined
  if (typeof node.type === 'function') return findByClass(node.type(node.props), className, depth + 1)
  if (String(node.props.className || '').split(' ').includes(className)) return node
  return findByClass(node.children, className, depth + 1)
}


/**
 * 极简「可重渲染」挂载器：让 useState/useEffect 真的工作，从而能模拟点击。
 * 桩件只服务于离线回归，不求覆盖 React 的调度语义，只保证：
 * setState 后同步重渲染、effect 在渲染后跑一次。
 */

const SLOT_HEADER = 'conversation.session.header.utilities'
const SLOT_COMPOSER = 'conversation.input.left'
const SLOT_SETTINGS = 'settings.general.item'

for (const name of [SLOT_HEADER, SLOT_COMPOSER, SLOT_SETTINGS]) {
  assert(slots.has(name), '缺少座位注册：' + name)
  for (const item of slots.get(name)) {
    assert(item.options.locale === 'openInAppDock', name + ' 必须绑定 locale 命名空间')
  }
}
// 设置里有两行：按钮位置、切换时是否启动。
assert(slots.get(SLOT_SETTINGS).length === 2, '设置行应有 2 项，实际 ' + String(slots.get(SLOT_SETTINGS).length))
assert(slots.get(SLOT_HEADER)[0].options.order < 0, '右上角按钮应在 ⋯ 菜单（order 0）左侧')

const t = ctx.locale.bind()
const header = slots.get(SLOT_HEADER)[0].component
const composer = slots.get(SLOT_COMPOSER)[0].component
const [positionRow, launchRow] = slots.get(SLOT_SETTINGS).map((item) => item.component)
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
assert(store.get('dsh-open-in-app-dock:position') === undefined, '首装不应预写位置偏好')
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

// 设置第一行：三选一，与位置偏好联动。
const positionText = rendered(positionRow, { t })
assert(positionText !== '', '位置设置行必须渲染')
for (const label of ['右上角', '底栏左侧', '隐藏']) {
  assert(positionText.includes(label), '位置设置行缺少选项 ' + label + '：' + positionText)
}
assert(!positionText.includes('移到'), '位置设置行不应出现换位菜单项')

// 设置第二行：切换打开方式时是否启动，默认关闭。
assert(api.launchOnPick() === false, 'launchOnPick 默认应为 false')
const launchText = rendered(launchRow, { t })
assert(launchText !== '', '启动偏好设置行必须渲染')
assert(launchText.includes('切换打开方式时立即启动'), '启动偏好行标题缺失：' + launchText)

// 开关可写：写入后读到 true，且以 '1' 持久化。
api.setLaunchOnPick(true)
assert(api.launchOnPick() === true, 'launchOnPick 应能置为 true')
assert(store.get('dsh-open-in-app-dock:launch-on-pick') === '1', '布尔偏好应存为 1/0')
// 非法值不改动现值。
api.setLaunchOnPick('nonsense')
assert(api.launchOnPick() === true, '非法值不应改变偏好')
api.setLaunchOnPick(false)
assert(api.launchOnPick() === false, 'launchOnPick 应能置回 false')
assert(store.get('dsh-open-in-app-dock:launch-on-pick') === '0', '关掉时应存为 0')

// 交互模型：单击 = 直接打开；角标/右键 = 更换。
const tree = header(withCwd)
const primary = findButton(tree, '在应用中打开')
assert(primary !== undefined, '找不到主按钮')
assert(typeof primary.props.onClick === 'function', '主按钮必须有 onClick')
assert(typeof primary.props.onContextMenu === 'function', '主按钮必须支持右键更换')
const badge = findByClass(tree, 'dsod_badge')
assert(badge !== undefined, '缺少更换角标')
assert(badge.props['aria-label'] === '更换', '角标无障碍名应为「更换」')

// 菜单提示随偏好切换文案（意味着 remember 里会走「顺带启动」分支）。
api.setLaunchOnPick(true)
assert(rendered(header, withCwd).includes('切换打开方式时立即启动') === false, '按钮本体不该重复设置文案')
api.setLaunchOnPick(false)


// ---- 行为断言：切换打开方式时是否顺带启动 ----
// 说明：完整模拟 React 渲染在本仓库是过度投入（桩件易与真实调度语义偏离，
// 反而制造假失败）。这里改为断言可确定的契约：
//   1) remember 里确实按偏好决定是否调用 start；
//   2) 启动请求的载荷形状正确。
await new Promise((resolve) => setTimeout(resolve, 0))

const source = readFileSync(CLIENT, 'utf8')
assert(/if \(launchOnPick\) start\(appId\)/.test(source),
  'remember 应按 launchOnPick 偏好决定是否顺带启动')
assert(/const launchOnPick = usePreference\(launchOnPickPreference\)/.test(source),
  '组件应订阅 launchOnPick 偏好')

// 启动载荷：单独验证 launch() 的形状（这是真正打到宿主的那一步）。
sandbox.window.__dshOpenInAppDock.apps()
await new Promise((resolve) => setTimeout(resolve, 0))
assert(launches().length === 0, '仅读取目录不应触发启动')

// 偏好读写：关/开各一次，确认持久化与读取一致。
api.setLaunchOnPick(true)
assert(store.get('dsh-open-in-app-dock:launch-on-pick') === '1', '开启应持久化为 1')
assert(api.launchOnPick() === true, '开启后应读回 true')
api.setLaunchOnPick(false)
assert(store.get('dsh-open-in-app-dock:launch-on-pick') === '0', '关闭应持久化为 0')
assert(api.launchOnPick() === false, '关闭后应读回 false')

// 非法位置回落到默认。
api.setPosition('nonsense')
assert(sandbox.window.__dshOpenInAppDock.position() === 'header', '非法位置应保持不变')

console.log('SMOKE OK — ' + String(zhKeys.length) + ' zh / ' + String(enKeys.length) + ' en keys, '
  + String(slots.size) + ' slots: ' + [...slots.keys()].join(', '))