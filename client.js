// dsh-open-in-app-dock — 浏览器半边。
//
// 目标：把会话头「更多 → 在应用中打开」里折叠起来的应用列表，取出来做成
// 输入框底栏左侧（composer 工具行左组）的常驻按钮，点一下即列应用，选中就打开当前工作区。
//
// 宿主事实（写代码前已逐条核对源码，改动前请先复核）：
//  · 座位 conversation.input.left 是 list / session 作用域，声明方在
//    dsh-client-ui-conversation 的 InputBar：渲染位置正是 .tools 组末尾（+ 号、权限、Plan 之后），
//    也就是输入框底栏的左侧。ownerProps 为 {}，组件另从标准 props 拿 sessionId / useSessions。
//  · 应用目录走宿主精确路由（同官方 dsh-client-ui-open-in-app 用同一批路由）：
//      GET  open-in-app/apps          -> { apps: string[] }        已探测到的应用 id，按宿主张单顺序
//      GET  open-in-app/icon/<id>     -> PNG 图标
//      POST open-in-app/open          -> { app, path } 启动应用打开目录，成功 200
//    路由本身带 connection 信任栅栏（cookie 鉴权 + Host/Origin 校验），浏览器同源 fetch 直接可用。
//  · 可用性每页只读一次（宿主侧目录惰性解析一次），因此这里也只在挂载时拉一次并缓存到模块级，
//    Web 部署（无桌面）时 apps 为空 -> 本插件完全不渲染任何东西，不留死按钮。
//  · 弹出层必须 portal 到 document.body：composer 卡片会裁剪 overflow（宿主文档明确要求）。
//  · 模块平台表里有 react / react-dom / @deepseek-ai/dsh-client-ui-primitives，但这里只用
//    react + react-dom，避免依赖不确定的导出名。
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
    /** 「上次用过哪个应用」的本地记忆，与官方 dsh.open-in-app.choice 分开，互不污染。 */
    const LAST_KEY = 'dsh-open-in-app-dock:last';
    const STYLE_ATTR = 'data-dsh-open-in-app-dock';

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
      },
    };

    /**
     * 应用显示名。产品名与官方 open-in-app 词典逐字一致（拿不到该命名空间时也能正确显示），
     * 未知 id 退回「首字母大写」。
     */
    const APP_NAMES = {
      cursor: 'Cursor',
      vscode: 'VS Code',
      vscodeinsiders: 'VS Code Insiders',
      windsurf: 'Windsurf',
      zed: 'Zed',
      sublimetext: 'Sublime Text',
      xcode: 'Xcode',
      androidstudio: 'Android Studio',
      intellij: 'IntelliJ IDEA',
      pycharm: 'PyCharm',
      webstorm: 'WebStorm',
      phpstorm: 'PhpStorm',
      goland: 'GoLand',
      rider: 'Rider',
      rustrover: 'RustRover',
      fork: 'Fork',
      sourcetree: 'Sourcetree',
      github: 'GitHub Desktop',
      tower: 'Tower',
      gitkraken: 'GitKraken',
      smartgit: 'SmartGit',
      sublimemerge: 'Sublime Merge',
      ghostty: 'Ghostty',
      warp: 'Warp',
      iterm: 'iTerm2',
      kitty: 'kitty',
      windowsterminal: 'Windows Terminal',
      gitbash: 'Git Bash',
      gnometerminal: 'GNOME Terminal',
      konsole: 'Konsole',
      terminal: 'Terminal',
    };
    const APP_NAMES_ZH = {
      finder: '访达',
      explorer: '文件资源管理器',
      filemanager: '文件管理器',
      terminal: '终端',
    };

    const CSS = [
      '/* 本插件自绘样式，类名统一 dsod_ 前缀，不覆盖宿主或其它插件的规则。 */',
      /* order:-1 把本控件排到 composer 工具行最左（+ 号之前）：slot outlet 是 display:contents，
         其子元素直接成为 .tools 的 flex item，因此 order 生效。 */
      '.dsod_root{display:flex;align-items:center;flex:none;min-width:0;order:-1}',
      '.dsod_btn{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:999px;',
      'background:var(--dsw-specific-selector,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);cursor:pointer;',
      'transition:background 140ms ease,opacity 140ms ease}',
      '.dsod_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-3))}',
      '.dsod_btn:disabled{opacity:.5;cursor:default}',
      '.dsod_btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:2px}',
      '.dsod_btn[data-busy="1"]{opacity:.6;cursor:progress}',
      '.dsod_btn[data-error="1"]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsod_btn img{width:16px;height:16px;border-radius:3px;object-fit:contain;display:block}',
      '.dsod_icon{width:16px;height:16px;display:block}',
      '.dsod_menu{position:fixed;z-index:2147483000;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;',
      'min-width:212px;max-width:300px;max-height:min(62vh,420px);overflow:auto;padding:6px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);',
      'box-shadow:0 12px 32px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);font-size:13px;line-height:1.4}',
      '.dsod_head{display:flex;flex-direction:column;gap:2px;padding:4px 8px 6px}',
      '.dsod_headTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsod_headPath{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
      'font-family:var(--dsw-font-family-mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap}',
      '.dsod_sep{height:0.5px;margin:4px 6px;background:var(--dsw-alias-border-l2,#0000001f)}',
      '.dsod_item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;',
      'background:transparent;color:inherit;font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dsod_item:hover:not(:disabled),.dsod_item:focus-visible{outline:none;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2))}',
      '.dsod_item:disabled{opacity:.45;cursor:default}',
      '.dsod_itemIcon{flex:none;width:16px;height:16px;display:grid;place-items:center;border-radius:3px;overflow:hidden}',
      '.dsod_itemIcon img{width:16px;height:16px;object-fit:contain;display:block}',
      '.dsod_itemName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsod_tag{flex:none;font-size:11px;padding:1px 6px;border-radius:999px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);color:var(--dsw-alias-label-secondary)}',
      '.dsod_note{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsod_noteError{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsod_retry{margin:2px 6px 4px;padding:6px 10px;font:inherit;font-size:12px;border-radius:8px;',
      'border:0.5px solid var(--dsw-alias-border-l2,#0000001f);background:var(--dsw-alias-bg-layer-2,transparent);',
      'color:var(--dsw-alias-label-primary);cursor:pointer}',
    ].join('');

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
    // 弹出菜单定位与关闭
    // ------------------------------------------------------------------
    const MENU_GAP = 8;

    /** 以锚点按钮右对齐、向上弹出；越界时钳制到视口内。 */
    function placeMenu(rect) {
      const width = 240;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.top + MENU_GAP);
      return { left, bottom, width };
    }

    // ------------------------------------------------------------------
    // 组件本体
    // ------------------------------------------------------------------
    /**
     * @param props sessionId（session 作用域标准 props）、useSessions（ui-session 标准 hooks）、t（本命名空间词典）。
     */
    function OpenInAppDock(props) {
      const { sessionId, useSessions, t } = props;
      const translate = typeof t === 'function'
        ? t
        : (key) => DICTS.zh[key] !== undefined ? DICTS.zh[key] : key;
      const lang = langOf(translate);

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

      // 外部点击 / Esc / 滚动 / 尺寸变化都关掉菜单，避免浮层脱离锚点。
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
        const onShift = () => { setOpen(false); };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onShift, true);
        window.addEventListener('resize', onShift);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('scroll', onShift, true);
          window.removeEventListener('resize', onShift);
        };
      }, [open]);

      // 失败提示是一次性的：3 秒后自行恢复常态。
      React.useEffect(() => {
        if (!error) return undefined;
        const timer = window.setTimeout(() => { setError(false); }, 3000);
        return () => { window.clearTimeout(timer); };
      }, [error]);

      if (typeof cwd !== 'string' || cwd === '') return null;
      if (apps !== null && apps.length === 0 && !loadError) return null;

      const list = apps === null ? [] : apps;
      const preferred = list.indexOf(last) >= 0 ? last : list[0];

      const toggle = () => {
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

      const choose = (appId) => {
        if (busyRef.current) return;
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

      const label = translate('button.label');
      const tooltip = preferred !== undefined && preferred !== ''
        ? translate('button.tooltip', { app: appName(preferred, lang) })
        : translate('button.tooltipGeneric');

      const button = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'dsod_btn',
        'aria-label': label,
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        title: tooltip,
        'data-busy': busy ? '1' : undefined,
        'data-error': error ? '1' : undefined,
        disabled: list.length === 0 && !loadError,
        onClick: toggle,
        onMouseDown: (event) => { event.preventDefault(); },
      },
      preferred !== undefined && preferred !== '' ? h(AppIcon, { id: preferred }) : h(OpenGlyph, { size: 16 }));

      const menu = open && rect !== null ? createPortal(
        h('div', {
          ref: menuRef,
          className: 'dsod_menu',
          role: 'menu',
          'aria-label': label,
          style: { left: String(Math.round(rect.left)) + 'px', width: String(rect.width) + 'px', bottom: String(Math.round(rect.bottom)) + 'px' },
        },
        h('div', { className: 'dsod_head' },
          h('span', { className: 'dsod_headTitle' }, translate('menu.title')),
          h('span', { className: 'dsod_headPath', title: cwd }, translate('menu.target', { path: cwd }))),
        h('div', { className: 'dsod_sep' }),
        list.length === 0
          ? h('div', { className: 'dsod_note' }, translate(loadError ? 'menu.loadError' : 'menu.empty'))
          : list.map((appId) => h('button', {
            key: appId,
            type: 'button',
            role: 'menuitem',
            className: 'dsod_item',
            disabled: busy,
            onClick: () => { choose(appId); },
          },
          h('span', { className: 'dsod_itemIcon' }, h(AppIcon, { id: appId })),
          h('span', { className: 'dsod_itemName' }, appName(appId, lang)),
          appId === last ? h('span', { className: 'dsod_tag' }, translate('menu.lastUsed')) : null)),
        loadError
          ? h(React.Fragment, null,
            h('div', { className: 'dsod_sep' }),
            h('div', { className: 'dsod_note dsod_noteError' }, translate('menu.loadError')),
            h('button', { type: 'button', className: 'dsod_retry', onClick: refresh }, translate('menu.retry')))
          : null,
        error ? h('div', { className: 'dsod_note dsod_noteError' }, translate('menu.error')) : null),
        document.body) : null;

      return h('div', { className: 'dsod_root' }, button, menu);
    }

    /** 从绑定后的 t 推断当前语言（词典只有 zh/en 两套）。 */
    function langOf(translate) {
      try {
        const probe = translate('menu.title');
        return probe === DICTS.zh['menu.title'] ? 'zh' : 'en';
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

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'open-in-app-dock',
        order: 100,
        locale: NS,
      }, OpenInAppDock));

      if (typeof window !== 'undefined') {
        window.__dshOpenInAppDock = {
          apps: () => loadApps(),
          last: () => readLast(),
        };
      }
    }

    return { name: 'dsh-open-in-app-dock', inject: inject, apply: apply };
  },
});