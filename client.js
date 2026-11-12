// dsh-open-in-app-dock — 浏览器半边。
//
// 目标：把会话头「更多 → 在应用中打开」里折叠起来的应用列表取出，做成一个常驻按钮；
// 位置可在三个候选之间切换（右上角工具区 / 输入框底栏左侧 / 隐藏），偏好存在本机。
//
// 宿主事实（写代码前已逐条核对源码，改动前请先复核）：
//  · conversation.session.header.utilities 是 list / session 作用域，渲染在会话标题栏右上，
//    紧邻官方「⋯ 更多」按钮的左边（ConversationSession.tsx:212）。官方 ui-schedule 用 order:-5
//    占同一座位，⋯ 按钮是 order 0，所以 order:-1 落在两者之间。这是「界面右上角」的正确座位。
//  · conversation.input.left 是 list / session 作用域，渲染在输入框工具行 .tools 末尾（+ 号之后）；
//    配合 order:-1 排到该行最左。ownerProps 为 {}。
//  · settings.general.item 是 list / root 作用域，通用设置页里的单行偏好座位；
//    ownerProps 为 {}，组件自带文案与控件（官方 DeveloperToolsRow 正是这么写的）。
//  · 应用目录走宿主精确路由（与官方 dsh-client-ui-open-in-app 同一批）：
//      GET  open-in-app/apps          -> { apps: string[] }
//      GET  open-in-app/icon/<id>     -> PNG 图标
//      POST open-in-app/open          -> { app, path } 启动应用打开目录，成功 200
//    路由自带 connection 信任栅栏（cookie 鉴权 + Host/Origin 校验），浏览器同源 fetch 直接可用。
//  · 可用性每页只读一次（宿主侧目录惰性解析一次），因此这里也只在挂载时拉一次并缓存到模块级。
//    Web 部署（无桌面）时 apps 为空 -> 完全不渲染，不留死按钮。
//  · 弹出层必须 portal 到 document.body：composer 卡片与会话头都会裁剪 overflow。
//  · 两个座位都是 list 且 outlet 是 display:contents：组件渲染 null 时不产生 flex item，
//    因此「注册在多个座位、只在一个座位真正渲染」不会留下空隙，无需动态增删注册。
window.__ModuleLoader__.load({
  id: '@local/dsh-open-in-app-dock',
  factory(require) {
    'use strict';

    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;

    /** locale 命名空间，同时决定 slot 注册诊断里的归属。 */
    const NS = 'openInAppDock';
    /** 与官方 open-in-app 完全相同的三条浏览器相对路由。 */
    const APPS_ROUTE = 'open-in-app/apps';
    const ICON_ROUTE = 'open-in-app/icon';
    const OPEN_ROUTE = 'open-in-app/open';
    /** 「上次用过哪个应用」的本地记忆。 */
    const LAST_KEY = 'dsh-open-in-app-dock:last';
    /** 按钮位置的本地偏好。 */
    const POSITION_KEY = 'dsh-open-in-app-dock:position';
    /** 「切换打开方式时是否顺带启动一次」的本地偏好。 */
    const LAUNCH_ON_PICK_KEY = 'dsh-open-in-app-dock:launch-on-pick';
    const STYLE_ATTR = 'data-dsh-open-in-app-dock';
    /** 新装默认落在右上角（用户要求的主位置）；可在设置里改。 */
    const DEFAULT_POSITION = 'header';

    /** 两个真实渲染位置；hidden 不注册任何渲染。 */
    const POSITIONS = {
      header: { slot: 'conversation.session.header.utilities', order: -1 },
      composer: { slot: 'conversation.input.left', order: -1 },
    };
    /** 设置行里的三选一，顺序即展示顺序。 */
    const POSITION_OPTIONS = ['header', 'composer', 'hidden'];

    const DICTS = {
      zh: {
        'button.label': '在应用中打开',
        'button.tooltip': '在应用中打开：用 {app} 打开当前工作区',
        'button.tooltipGeneric': '在应用中打开当前工作区',
        'menu.title': '在应用中打开',
        'menu.target': '工作区：{path}',
        'menu.lastUsed': '上次',
        'menu.empty': '没有检测到可用的本地应用。',
        'menu.busy': '正在打开…',
        'menu.error': '打开失败，请重试。',
        'menu.loadError': '无法读取应用列表，点击重试。',
        'menu.retry': '重试',
        'menu.pickTitle': '更换打开方式',
        'menu.pickTarget': '下次单击将用以下应用打开',
        'menu.pickTargetLaunch': '选中后将立刻用该应用打开',
        'button.change': '更换',
        'button.changeHint': '单击用 {app} 打开；右键或点角标更换',
        'settings.title': '「在应用中打开」按钮位置',
        'settings.desc': '把应用列表放在会话标题栏右上角、输入框底栏左侧，或隐藏。偏好保存在本机浏览器。',
        'settings.launchTitle': '切换打开方式时立即启动',
        'settings.launchDesc': '开启后，在列表里选中另一个应用会立刻用它打开当前工作区；关闭时只更换下次单击使用的应用，不打断当前操作。',
        'pos.header': '右上角',
        'pos.composer': '底栏左侧',
        'pos.hidden': '隐藏',
      },
      en: {
        'button.label': 'Open in app',
        'button.tooltip': 'Open in app: open this workspace with {app}',
        'button.tooltipGeneric': 'Open this workspace in an application',
        'menu.title': 'Open in app',
        'menu.target': 'Workspace: {path}',
        'menu.lastUsed': 'Last',
        'menu.empty': 'No local application was detected.',
        'menu.busy': 'Opening…',
        'menu.error': 'Could not open. Try again.',
        'menu.loadError': 'Could not read the application list. Click to retry.',
        'menu.retry': 'Retry',
        'menu.pickTitle': 'Change how it opens',
        'menu.pickTarget': 'A single click will then open with',
        'menu.pickTargetLaunch': 'Picking one opens with it right away',
        'button.change': 'Change',
        'button.changeHint': 'Click opens with {app}; right-click or use the badge to change',
        'settings.title': '"Open in app" button position',
        'settings.desc': 'Place the application list in the session header top-right, at the left of the composer toolbar, or hide it. The preference is stored in this browser.',
        'settings.launchTitle': 'Launch immediately when switching',
        'settings.launchDesc': 'When on, picking another application in the list opens the workspace with it right away. When off, picking only changes what the next click uses, without interrupting what you are doing.',
        'pos.header': 'Top-right',
        'pos.composer': 'Composer left',
        'pos.hidden': 'Hidden',
      },
    };

    /**
     * 应用显示名。产品名与官方 open-in-app 词典逐字一致（拿不到该命名空间时也能正确显示），
     * 未知 id 退回「首字母大写」。
     */
    const APP_NAMES = {
      cursor: 'Cursor', vscode: 'VS Code', vscodeinsiders: 'VS Code Insiders',
      windsurf: 'Windsurf', zed: 'Zed', sublimetext: 'Sublime Text', xcode: 'Xcode',
      androidstudio: 'Android Studio', intellij: 'IntelliJ IDEA', pycharm: 'PyCharm',
      webstorm: 'WebStorm', phpstorm: 'PhpStorm', goland: 'GoLand', rider: 'Rider',
      rustrover: 'RustRover', fork: 'Fork', sourcetree: 'Sourcetree',
      github: 'GitHub Desktop', tower: 'Tower', gitkraken: 'GitKraken',
      smartgit: 'SmartGit', sublimemerge: 'Sublime Merge', ghostty: 'Ghostty',
      warp: 'Warp', iterm: 'iTerm2', kitty: 'kitty',
      windowsterminal: 'Windows Terminal', gitbash: 'Git Bash',
      gnometerminal: 'GNOME Terminal', konsole: 'Konsole', terminal: 'Terminal',
    };
    const APP_NAMES_ZH = {
      finder: '访达', explorer: '文件资源管理器', filemanager: '文件管理器', terminal: '终端',
    };

    const CSS = [
      '/* 本插件自绘样式，类名统一 dsod_ 前缀，不覆盖宿主或其它插件的规则。 */',
      /* order:-1 把控件排到所在 list 的最前：两个座位都是 flex 容器，outlet 是 display:contents。 */
      '.dsod_root{display:flex;align-items:center;flex:none;min-width:0;order:-1}',
      /* 主按钮 + 右下角「换」角标叠在一起：悬浮时才露出角标，单击区域仍是整颗按钮。 */
      '.dsod_stack{position:relative;display:flex;align-items:center;flex:none}',
      '.dsod_btn{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:999px;',
      'background:var(--dsw-specific-selector,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);cursor:pointer;',
      'transition:background 140ms ease,opacity 140ms ease}',
      '.dsod_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-3))}',
      '.dsod_btn:disabled{opacity:.5;cursor:default}',
      '.dsod_btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}',
      '.dsod_btn[data-busy="1"]{opacity:.6;cursor:progress}',
      '.dsod_btn[data-error="1"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      /* 会话头里的按钮跟随官方 headarMenuButton 观感：透明底、次要色、28px 见方。 */
      '.dsod_root[data-anchor="header"] .dsod_btn{background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsod_root[data-anchor="header"] .dsod_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-3))}',
      '.dsod_btn img{width:16px;height:16px;border-radius:3px;object-fit:contain;display:block}',
      '.dsod_icon{width:16px;height:16px;display:block}',
      /* 角标：默认透明且不占位（绝对定位挂在按钮右下角）；悬浮/聚焦/菜单展开时淡入。 */
      '.dsod_badge{position:absolute;right:-3px;bottom:-3px;display:grid;place-items:center;width:13px;height:13px;padding:0;',
      'border:1px solid var(--dsw-alias-border-l2,#0000001f);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;transform:scale(.85);',
      'transition:opacity 120ms ease,transform 120ms ease,background 120ms ease;pointer-events:none}',
      '.dsod_stack:hover .dsod_badge,.dsod_stack:focus-within .dsod_badge,.dsod_root[data-open="1"] .dsod_badge',
      '{opacity:1;transform:scale(1);pointer-events:auto}',
      '.dsod_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-3));',
      'color:var(--dsw-alias-label-primary)}',
      '.dsod_badge:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px}',
      '.dsod_badgeGlyph{display:block}',
      '.dsod_menu{position:fixed;z-index:2147483000;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;',
      'min-width:212px;max-width:300px;max-height:min(62vh,420px);overflow:auto;padding:6px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);',
      'box-shadow:0 12px 32px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);font-size:13px;line-height:1.4}',
      '.dsod_head{display:flex;flex-direction:column;gap:2px;padding:4px 8px 6px}',
      '.dsod_headTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsod_headPath{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
      'font-family:var(--dsw-font-family-mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsod_sep{height:0.5px;margin:4px 6px;background:var(--dsw-alias-border-l2,#0000001f)}',
      '.dsod_item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;',
      'background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dsod_item:hover:not(:disabled),.dsod_item:focus-visible{outline:none;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
      /* 当前生效的那一行：图标列打勾位留白由文字色体现，避免多一列挤压名称。 */
      '.dsod_item.is-on{color:var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsod_item:disabled{opacity:.45;cursor:default}',
      '.dsod_itemIcon{flex:none;width:16px;height:16px;display:grid;place-items:center;border-radius:3px;overflow:hidden}',
      '.dsod_itemIcon img{width:16px;height:16px;object-fit:contain;display:block}',
      '.dsod_itemName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsod_tag{flex:none;font-size:11px;padding:1px 6px;border-radius:999px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);color:var(--dsw-alias-label-secondary)}',
      '.dsod_note{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsod_noteHint{padding:2px 8px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsod_noteError{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsod_retry{margin:2px 6px 4px;padding:6px 10px;font:inherit;font-size:12px;border-radius:8px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-layer-2,transparent);',
      'color:var(--dsw-alias-label-primary);cursor:pointer}',
      /* 设置行：标题 + 说明 + 三选一分段控件，与官方偏好行同构。 */
      '.dsod_row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0}',
      '.dsod_rowText{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsod_rowTitle{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}',
      '.dsod_rowDesc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.dsod_seg{display:flex;flex:none;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsod_segBtn{padding:5px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:12px;line-height:1.4;cursor:pointer;white-space:nowrap}',
      '.dsod_segBtn:hover{color:var(--dsw-alias-label-primary)}',
      '.dsod_segBtn.is-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);',
      'box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.dsod_segBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px}',
      /* 设置里的开关：与宿主 Switch 同尺寸观感，自绘以免依赖不确定的导出名。 */
      '.dsod_switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0.5px solid var(--dsw-alias-border-l2,#0000001f);',
      'border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background 140ms ease}',
      '.dsod_switch.is-on{background:var(--dsw-alias-state-business-primary,#4f8cff);border-color:transparent}',
      '.dsod_switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}',
      '.dsod_knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;',
      'box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform 140ms ease}',
      '.dsod_switch.is-on .dsod_knob{transform:translateX(16px)}',
    ].join('');

    // ------------------------------------------------------------------
    // 本地偏好：localStorage 是真相源，内存快照让 React 同步读。
    // 两项偏好（按钮位置、切换时是否启动）共用同一套存储与订阅逻辑。
    // ------------------------------------------------------------------
    /**
     * 建一个持久化偏好。
     * @param key localStorage 键名。
     * @param fallback 没有有效值时使用的默认值。
     * @param normalize 把任意输入收成合法值；不认识的值返回 undefined，表示「不写、也不改」。
     */
    function createPreference(key, fallback, normalize) {
      const listeners = new Set();
      const read = () => {
        try {
          const value = normalize(window.localStorage.getItem(key));
          return value === undefined ? fallback : value;
        } catch (error) {
          // 坏数据或 localStorage 被禁用：退回默认值，不把异常抛给宿主。
          return fallback;
        }
      };
      let snapshot = read();
      const preference = {
        get: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set: (next) => {
          const value = normalize(next);
          if (value === undefined || value === snapshot) return;
          snapshot = value;
          try {
            // 布尔用 '1'/'0' 存，字符串原样存，便于在 DevTools 里直接看懂。
            window.localStorage.setItem(key, typeof value === 'boolean' ? (value ? '1' : '0') : value);
          } catch (error) {
            // 写入失败时本次会话仍按内存值生效。
          }
          for (const listener of Array.from(listeners)) {
            try { listener(); } catch (error) { /* 单个订阅者出错不影响其他订阅者 */ }
          }
        },
      };
      return preference;
    }

    /** 订阅一个偏好的 hook；值一变，用到它的组件都会重渲染。 */
    function usePreference(preference) {
      const [value, setValue] = React.useState(preference.get);
      React.useEffect(
        () => preference.subscribe(() => { setValue(preference.get()); }),
        [],
      );
      return value;
    }

    /** 按钮位置：右上角 / 底栏左侧 / 隐藏。 */
    const positionPreference = createPreference(
      POSITION_KEY,
      DEFAULT_POSITION,
      (value) => (isPosition(value) ? value : undefined),
    );

    /**
     * 切换打开方式时是否顺带启动一次。
     * 默认 false：右键/角标只改「下次单击用哪个」，不打断当前操作。
     * 存成 '1'/'0'；没写过（null）走默认，其他脏值也走默认。
     */
    const launchOnPickPreference = createPreference(
      LAUNCH_ON_PICK_KEY,
      false,
      (value) => {
        if (value === '1' || value === 1 || value === true) return true;
        if (value === '0' || value === 0 || value === false) return false;
        return value === null || value === undefined ? false : undefined;
      },
    );

    function isPosition(value) {
      return value === 'header' || value === 'composer' || value === 'hidden';
    }

    // ------------------------------------------------------------------
    // 应用目录：模块级单次读取，卸载时由 ctx.effect 清空以便重载后重读。
    // ------------------------------------------------------------------
    let appsPromise = null;

    function loadApps() {
      if (appsPromise !== null) return appsPromise;
      appsPromise = fetch(APPS_ROUTE, { headers: { accept: 'application/json' } })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + String(response.status));
          return response.json();
        })
        .then((payload) => {
          const list = payload && Array.isArray(payload.apps) ? payload.apps : [];
          return list.filter((id) => typeof id === 'string' && id !== '');
        })
        .catch((error) => {
          // 读取失败与「没有应用」必须分开：前者给重试，后者直接不渲染。
          appsPromise = null;
          throw error;
        });
      return appsPromise;
    }

    /** 启动一个应用打开目录；返回 'opened' | 'failed'。 */
    async function launch(appId, path) {
      try {
        const response = await fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: appId, path }),
        });
        return response.ok ? 'opened' : 'failed';
      } catch (error) {
        return 'failed';
      }
    }

    function readLast() {
      try {
        return window.localStorage.getItem(LAST_KEY) || '';
      } catch (error) {
        return '';
      }
    }

    function writeLast(id) {
      try {
        window.localStorage.setItem(LAST_KEY, id);
      } catch (error) {
        // 存储被禁用时仅本次会话内生效。
      }
    }

    function appName(id, lang) {
      if (lang === 'zh' && APP_NAMES_ZH[id]) return APP_NAMES_ZH[id];
      if (APP_NAMES[id]) return APP_NAMES[id];
      return id.charAt(0).toUpperCase() + id.slice(1);
    }

    function iconUrl(id) {
      return ICON_ROUTE + '/' + encodeURIComponent(id);
    }

    /** 通用「在应用中打开」字形：方框 + 右上箭头。 */
    function OpenGlyph({ size }) {
      const px = typeof size === 'number' ? size : 16;
      return h('svg', {
        className: 'dsod_icon', width: px, height: px, viewBox: '0 0 16 16',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
      h('path', { d: 'M9.2 2.4h4.4v4.4' }),
      h('path', { d: 'M13.3 2.7 7.6 8.4' }),
      h('path', { d: 'M12.4 9.6v3.1a.9.9 0 0 1-.9.9H3.7a.9.9 0 0 1-.9-.9V4.9a.9.9 0 0 1 .9-.9h3.1' }));
    }

    /** 单个应用图标；加载失败退回通用字形，绝不显示破图。 */
    function AppIcon({ id }) {
      const [failed, setFailed] = React.useState(false);
      if (failed) return h(OpenGlyph, { size: 16 });
      return h('img', {
        src: iconUrl(id), width: 16, height: 16, alt: '', draggable: false,
        onError: () => { setFailed(true); },
      });
    }

    // ------------------------------------------------------------------
    // 弹出菜单定位：按锚点上下空间自动选择方向，越界时钳制到视口内。
    // ------------------------------------------------------------------
    const MENU_GAP = 8;
    const MENU_WIDTH = 240;
    const MENU_MAX_HEIGHT = 420;

    /** 视口尺寸；宿主环境一定有，这里兜底只为让异常环境（测试/嵌入）不至于算出 NaN。 */
    function viewport() {
      const width = Number(window.innerWidth);
      const height = Number(window.innerHeight);
      return {
        width: Number.isFinite(width) && width > 0 ? width : 1024,
        height: Number.isFinite(height) && height > 0 ? height : 768,
      };
    }

    /**
     * 依据锚点位置算菜单坐标：在上半屏向下弹，下半屏向上弹，左右越界时钳制。
     * @param rect 锚点的 getBoundingClientRect()。
     */
    function placeMenu(rect) {
      const view = viewport();
      const width = Math.min(MENU_WIDTH, Math.max(180, view.width - 16));
      const left = Math.max(8, Math.min(rect.right - width, view.width - width - 8));
      const below = rect.top < view.height * 0.5;
      if (below) {
        const top = Math.min(rect.bottom + MENU_GAP, Math.max(8, view.height - MENU_MAX_HEIGHT - 8));
        return { left, top, width, mode: 'down' };
      }
      return { left, bottom: Math.max(8, view.height - rect.top + MENU_GAP), width, mode: 'up' };
    }

    // ------------------------------------------------------------------
    // 组件本体
    // ------------------------------------------------------------------
    /**
     * @param props anchor（'header' | 'composer'）、sessionId 与 useSessions（session 作用域标准 props）、t（本命名空间词典）。
     */
    function OpenInAppButton(props) {
      const { anchor, sessionId, useSessions, t } = props;
      const translate = typeof t === 'function'
        ? t
        : (key) => DICTS.zh[key] !== undefined ? DICTS.zh[key] : key;
      const lang = langOf(translate);
      const position = usePreference(positionPreference);
      const launchOnPick = usePreference(launchOnPickPreference);

      // cwd 走 Session 列表行（SessionSnapshot 本身不含 cwd）。没有会话行或没有工作区时不渲染。
      const cwd = typeof useSessions === 'function'
        ? useSessions((state) => {
          const row = state && state.byId ? state.byId[sessionId] : undefined;
          return row && typeof row.cwd === 'string' ? row.cwd : undefined;
        })
        : undefined;

      const [apps, setApps] = React.useState(null);
      const [loadError, setLoadError] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(false);
      const [last, setLast] = React.useState(readLast);
      const [rect, setRect] = React.useState(null);
      const buttonRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const busyRef = React.useRef(false);

      const refresh = React.useCallback(() => {
        setLoadError(false);
        loadApps()
          .then((list) => { setApps(list); })
          .catch(() => { setApps([]); setLoadError(true); });
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      // 位置切走后菜单不该留一个脱离锚点的浮层。
      React.useEffect(() => {
        if (position !== anchor) setOpen(false);
      }, [position, anchor]);

      // 外部点击 / Esc / 滚动 / 尺寸变化都关掉菜单。
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (buttonRef.current && buttonRef.current.contains(target)) return;
          if (menuRef.current && menuRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        };
        const close = () => { setOpen(false); };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('scroll', close, true);
          window.removeEventListener('resize', close);
        };
      }, [open]);

      // 失败提示是一次性的：3 秒后自行恢复常态。
      React.useEffect(() => {
        if (!error) return undefined;
        const timer = window.setTimeout(() => { setError(false); }, 3000);
        return () => { window.clearTimeout(timer); };
      }, [error]);

      // 只在自己的位置上渲染；位置为 hidden 时两个座位都不渲染。
      if (position !== anchor) return null;
      if (typeof cwd !== 'string' || cwd === '') return null;
      if (apps !== null && apps.length === 0 && !loadError) return null;

      const list = apps === null ? [] : apps;
      const preferred = list.indexOf(last) >= 0 ? last : list[0];
      const hasTarget = preferred !== undefined && preferred !== '' && !loadError;
      const currentName = preferred !== undefined && preferred !== '' ? appName(preferred, lang) : '';

      /** 真正发起一次启动；单击与菜单共用，保证同一时刻只有一个在飞。 */
      const start = (appId) => {
        if (busyRef.current || typeof cwd !== 'string') return;
        busyRef.current = true;
        setBusy(true);
        setOpen(false);
        void launch(appId, cwd).then((outcome) => {
          busyRef.current = false;
          setBusy(false);
          if (outcome === 'opened') {
            setLast(appId);
            writeLast(appId);
            setError(false);
          } else {
            setError(true);
          }
        });
      };

      /** 打开「更换」菜单；只想换应用，不立刻打开。 */
      const showMenu = () => {
        if (busyRef.current) return;
        if (open) {
          setOpen(false);
          return;
        }
        if (buttonRef.current) setRect(placeMenu(buttonRef.current.getBoundingClientRect()));
        setError(false);
        setOpen(true);
        if (loadError) refresh();
      };

      /**
       * 单击：直接用记住的应用打开。
       * 没有可用目标（读取失败 / 一个应用都没有）时没有「记住的应用」可言，
       * 这时单击改为展开菜单，让用户看到原因与重试入口。
       */
      const onPrimary = () => {
        if (busyRef.current) return;
        if (!hasTarget) {
          showMenu();
          return;
        }
        start(preferred);
      };

      /**
       * 菜单里选一个：记住它，成为「下次单击用哪个」。
       * 偏好 launchOnPick 为真时，同时立刻用它打开一次（等于「换完顺手打开」）；
       * 默认只切换不启动，避免打断手头的操作。
       */
      const remember = (appId) => {
        setLast(appId);
        writeLast(appId);
        setOpen(false);
        setError(false);
        if (launchOnPick) start(appId);
      };

      /** 右键：换应用，同时压掉系统菜单。 */
      const onContextMenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        showMenu();
      };

      const tooltip = currentName !== ''
        ? translate('button.changeHint', { app: currentName })
        : translate('button.tooltipGeneric');

      const button = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'dsod_btn',
        'aria-label': currentName !== '' ? translate('button.tooltip', { app: currentName }) : translate('button.label'),
        title: tooltip,
        'data-busy': busy ? '1' : undefined,
        'data-error': error ? '1' : undefined,
        disabled: busy,
        onClick: onPrimary,
        onContextMenu: onContextMenu,
        onMouseDown: (event) => { event.preventDefault(); },
      },
      preferred !== undefined && preferred !== '' ? h(AppIcon, { id: preferred }) : h(OpenGlyph, { size: 16 }));

      // 角标：平时淡出，鼠标悬浮到按钮上或聚焦时浮现；点它只换应用。
      const badge = h('button', {
        type: 'button',
        className: 'dsod_badge',
        'aria-label': translate('button.change'),
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        title: translate('button.change'),
        tabIndex: -1,
        disabled: busy,
        onClick: (event) => { event.stopPropagation(); showMenu(); },
        onMouseDown: (event) => { event.preventDefault(); },
        onContextMenu: onContextMenu,
      }, h('svg', {
        className: 'dsod_badgeGlyph', width: 8, height: 8, viewBox: '0 0 8 8',
        'aria-hidden': 'true', focusable: 'false',
      }, h('path', {
        d: 'M1 3.2 4 6.6 7 3.2', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      })));

      const menu = open && rect !== null ? createPortal(
        h('div', {
          ref: menuRef,
          className: 'dsod_menu',
          role: 'menu',
          'aria-label': translate('menu.pickTitle'),
          'data-mode': rect.mode,
          style: {
            left: String(Math.round(rect.left)) + 'px',
            width: String(rect.width) + 'px',
            ...(rect.mode === 'down'
              ? { top: String(Math.round(rect.top)) + 'px' }
              : { bottom: String(Math.round(rect.bottom)) + 'px' }),
          },
        },
        h('div', { className: 'dsod_head' },
          h('span', { className: 'dsod_headTitle' }, translate('menu.pickTitle')),
          h('span', { className: 'dsod_headPath', title: cwd }, translate('menu.target', { path: cwd }))),
        h('div', { className: 'dsod_note dsod_noteHint' },
          translate(launchOnPick ? 'menu.pickTargetLaunch' : 'menu.pickTarget')),
        h('div', { className: 'dsod_sep' }),
        list.length === 0
          ? h('div', { className: 'dsod_note' }, translate(loadError ? 'menu.loadError' : 'menu.empty'))
          : list.map((appId) => h('button', {
            key: appId,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': appId === preferred ? 'true' : 'false',
            className: 'dsod_item' + (appId === preferred ? ' is-on' : ''),
            disabled: busy,
            onClick: () => { remember(appId); },
          },
          h('span', { className: 'dsod_itemIcon' }, h(AppIcon, { id: appId })),
          h('span', { className: 'dsod_itemName' }, appName(appId, lang)),
          appId === preferred ? h('span', { className: 'dsod_tag' }, translate('menu.lastUsed')) : null)),
        loadError
          ? h(React.Fragment, null,
            h('div', { className: 'dsod_sep' }),
            h('div', { className: 'dsod_note dsod_noteError' }, translate('menu.loadError')),
            h('button', { type: 'button', className: 'dsod_retry', onClick: refresh }, translate('menu.retry')))
          : null,
        error ? h('div', { className: 'dsod_note dsod_noteError' }, translate('menu.error')) : null),
        document.body) : null;

      return h('div', { className: 'dsod_root', 'data-anchor': anchor, 'data-open': open ? '1' : '0' },
        h('div', { className: 'dsod_stack' }, button, badge), menu);
    }

    /** 右上角座位（会话标题栏，⋯ 左侧）。 */
    function HeaderOpenInApp(props) {
      return h(OpenInAppButton, Object.assign({}, props, { anchor: 'header' }));
    }

    /** 底栏左侧座位（输入框工具行最左）。 */
    function ComposerOpenInApp(props) {
      return h(OpenInAppButton, Object.assign({}, props, { anchor: 'composer' }));
    }

    /** 通用设置里的一行：三选一切换按钮位置。 */
    function PositionSettingRow(props) {
      const translate = useTranslator(props);
      const position = usePreference(positionPreference);
      return h('div', { className: 'dsod_root dsod_row', 'data-anchor': 'settings' },
        h('div', { className: 'dsod_rowText' },
          h('div', { className: 'dsod_rowTitle' }, translate('settings.title')),
          h('div', { className: 'dsod_rowDesc' }, translate('settings.desc'))),
        h('div', { className: 'dsod_seg', role: 'group', 'aria-label': translate('settings.title') },
          POSITION_OPTIONS.map((id) => h('button', {
            key: id,
            type: 'button',
            className: 'dsod_segBtn' + (position === id ? ' is-on' : ''),
            'aria-pressed': position === id ? 'true' : 'false',
            onClick: () => { positionPreference.set(id); },
          }, translate('pos.' + id)))));
    }

    /**
     * 通用设置里的另一行：切换打开方式时是否顺带启动一次。
     * 用自绘开关而不是宿主 Switch，避免依赖平台表里不确定的导出名。
     */
    function LaunchOnPickSettingRow(props) {
      const translate = useTranslator(props);
      const enabled = usePreference(launchOnPickPreference);
      return h('div', { className: 'dsod_root dsod_row', 'data-anchor': 'settings' },
        h('div', { className: 'dsod_rowText' },
          h('div', { className: 'dsod_rowTitle' }, translate('settings.launchTitle')),
          h('div', { className: 'dsod_rowDesc' }, translate('settings.launchDesc'))),
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'dsod_switch' + (enabled ? ' is-on' : ''),
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': translate('settings.launchTitle'),
          onClick: () => { launchOnPickPreference.set(!enabled); },
        }, h('span', { className: 'dsod_knob', 'aria-hidden': 'true' })));
    }

    /** 取本插件的词典函数；拿不到绑定的 t 时退回中文表（便于离线测试）。 */
    function useTranslator(props) {
      return typeof props.t === 'function'
        ? props.t
        : (key) => DICTS.zh[key] !== undefined ? DICTS.zh[key] : key;
    }

    /** 从绑定后的 t 推断当前语言（词典只有 zh/en 两套）。 */
    function langOf(translate) {
      try {
        return translate('menu.title') === DICTS.zh['menu.title'] ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    function installStyles() {
      const element = document.createElement('style');
      element.setAttribute(STYLE_ATTR, '');
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => { element.remove(); };
    }

    // ------------------------------------------------------------------
    // 插件入口
    // ------------------------------------------------------------------
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'open-in-app-dock: locale');
      ctx.effect(() => installStyles(), 'open-in-app-dock: styles');
      // 卸载时清空目录缓存，重新启用会重新向宿主读一次可用性。
      ctx.effect(() => () => { appsPromise = null; }, 'open-in-app-dock: app cache');

      // 两个座位都静态注册；组件只在自己的位置上渲染，其余情况返回 null。
      // list 座位的 outlet 是 display:contents，返回 null 不会留下空隙。
      ctx.slots.inject(POSITIONS.header.slot, () => ctx.slots.register({
        name: POSITIONS.header.slot,
        id: 'open-in-app-dock',
        order: POSITIONS.header.order,
        locale: NS,
      }, HeaderOpenInApp));
      ctx.slots.inject(POSITIONS.composer.slot, () => ctx.slots.register({
        name: POSITIONS.composer.slot,
        id: 'open-in-app-dock',
        order: POSITIONS.composer.order,
        locale: NS,
      }, ComposerOpenInApp));

      // 设置 → 通用 → 本行，切换位置。
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'open-in-app-dock',
        order: 60,
        locale: NS,
      }, PositionSettingRow));
      // 设置 → 通用 → 紧接一行：切换打开方式时是否顺带启动。
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'open-in-app-dock-launch-on-pick',
        order: 61,
        locale: NS,
      }, LaunchOnPickSettingRow));

      if (typeof window !== 'undefined') {
        window.__dshOpenInAppDock = {
          apps: () => loadApps(),
          last: () => readLast(),
          position: positionPreference.get,
          setPosition: positionPreference.set,
          launchOnPick: launchOnPickPreference.get,
          setLaunchOnPick: launchOnPickPreference.set,
        };
      }
    }

    return { name: 'dsh-open-in-app-dock', inject: inject, apply: apply };
  },
});