/**
 * dsh-switchboard —— 浏览器半边。
 *
 * 两个入口，互不影响：
 *
 *  A. 对话头部的「模型」按钮（`conversation.session.header.actions`）
 *     点开列出当前 Lead 会话下的队友与子智能体，点某一行就地选 provider/model，
 *     POST `/api/v1/switchboard/member` 后**立刻**作用到存活的子 Agent 上；
 *     已经结束的成员写进点名表，下次 spawn 生效。
 *
 *  B. 插件管理页的设置卡片（`plugins.bundle.config`）
 *     1. 读 `/api/v1/switchboard/state` 拿当前有效设置与可用模型路由；
 *     2. 把规则、默认路由、委派范围画成一张卡片，改完 POST `/rules` 并回填；
 *     3. 显示 `/recent` 的最近委派（端点缺失就整块不画）。
 *
 * 硬约束（被评审过的线）：
 *  - 颜色只用 `var(--dsw-alias-*)` 主题 token，明暗切换由宿主负责；
 *  - 不 require 任何 `@deepseek-ai/*`，只 require react，react 由宿主加载器提供；
 *  - 不写 DOM 到 document.body：样式跟着组件树用 <style> 渲染；
 *  - 数据面全部收敛在 `request()` 里，任何异常都不许把整块 UI 打崩；
 *  - 只有「保存」「应用」会写宿主；监听器与定时器都在组件卸载/`apply` 返回值里清理。
 *
 * 本文件是纯 CJS bundle，由 `window.__ModuleLoader__.load` 包装。
 */
window.__ModuleLoader__.load({
  id: 'dsh-switchboard',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    const SLOT_NAME = 'plugins.bundle.config';
    const SLOT_KEY = 'dsh-switchboard';

    /** 对话头部操作区的插槽：这里是「点成员换模型」的主入口。 */
    const HEADER_SLOT = 'conversation.session.header.actions';
    const PICKER_ID = 'switchboard-picker';

    const STATE_PATH = '/api/v1/switchboard/state';
    const RULES_PATH = '/api/v1/switchboard/rules';
    const RECENT_PATH = '/api/v1/switchboard/recent';
    const MEMBERS_PATH = '/api/v1/switchboard/members';
    const MEMBER_SET_PATH = '/api/v1/switchboard/member';
    const SESSION_PATH = '/api/v1/switchboard/session';
    const SPAWN_PATH = '/api/v1/switchboard/spawn';
    const BULK_PATH = '/api/v1/switchboard/bulk';
    const SIMULATE_PATH = '/api/v1/switchboard/simulate';

    /** 队友名的合法形状，和宿主侧同一条正则（lower-kebab-case）。 */
    const TEAMMATE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

    /** 批量应用后的撤销窗口长度（毫秒）。 */
    const BULK_UNDO_MS = 5000;

    /**
     * 跨面板 toast：挂在框架级 `shell.overlay`（`dsh-client-ui-layout` 声明的
     * list 槽）里，所以关掉设置卡片/头部面板也看得见。
     *
     * 这个槽由 ui-layout 的 AppFrame 声明，而 ui-layout 已经在我们的
     * `dsh.client.inject` 依赖链上（`dsh-client-ui-conversation` 的 inject 里就有
     * 它），所以**不需要**往 `package.json` 的 inject 里加 layout，也就**不需要重启**。
     * 万一某个版本里这个槽没被声明：`slots.inject` 的回调根本不会跑，toast 静默失效，
     * 面板内提示照常 —— 不会抛错。
     */
    const TOAST_SLOT = 'shell.overlay';
    const TOAST_ID = 'switchboard-toast';
    const TOAST_LIMIT = 3;
    const TOAST_DEDUPE_MS = 1500;
    const TOAST_OK_MS = 3000;

    /** 最近使用过的模型：`["provider\0model", ...]`，最多 5 条，LRU。 */
    const RECENT_KEY = 'dsh-switchboard:recent-models';
    const RECENT_LIMIT = 5;
    const RECENT_SEP = '\u0000';

    /* ── 取数：所有失败都收敛成 {ok:false, status, data}，从不抛 ─────────────── */

    async function request(path, init) {
      if (typeof fetch !== 'function') return { ok: false, status: 0, data: undefined };
      try {
        const response = await fetch(path, {
          credentials: 'include',
          ...(init === undefined ? {} : init),
        });
        let text = '';
        try {
          text = await response.text();
        } catch {
          text = '';
        }
        let data;
        try {
          data = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          data = undefined;
        }
        return { ok: response.ok === true, status: response.status, data };
      } catch (error) {
        return { ok: false, status: 0, data: undefined, error };
      }
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function textOf(value) {
      return typeof value === 'string' ? value.trim() : '';
    }

    function messageOf(error) {
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      try {
        return String(error);
      } catch {
        return '未知错误';
      }
    }

    /* ── 数据形状：宿主返回的东西一律先归一化，界面只认归一化后的形状 ───────── */

    /** 一条路由：provider + model 缺一不可；reasoningEffort 可为空串（= 自动挑）。 */
    function readRoute(raw) {
      if (!isObject(raw)) return null;
      const provider = textOf(raw.provider);
      const model = textOf(raw.model);
      if (provider === '' || model === '') return null;
      return { provider, model, reasoningEffort: textOf(raw.reasoningEffort) };
    }

    function readRules(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        const route = readRoute(item);
        if (route === null) continue;
        out.push({ match: textOf(item.match), ...route });
      }
      return out;
    }

    function readSettings(raw) {
      const value = isObject(raw) ? raw : {};
      return {
        enabled: value.enabled !== false,
        rules: readRules(value.rules),
        defaultRoute: readRoute(value.defaultRoute),
        maxDepth: Number.isSafeInteger(value.maxDepth) ? value.maxDepth : 1,
        applyToFork: value.applyToFork === true,
      };
    }

    /**
     * 一个模型：id + 展示名 + 它**自己声明**的推理档位。
     *
     * 档位来源是 `reasoning.efforts`（宿主契约，形如 `[{id, name}]`）；同时认
     * 平铺的 `efforts`，这样宿主半端还没升级序列化时也不会把界面打死。读不到就是
     * 空数组 = 「该模型不声明档位」，界面据此禁用档位控件，而不是瞎猜一个档位。
     */
    function readModel(raw) {
      if (!isObject(raw)) return null;
      const id = textOf(raw.id);
      if (id === '') return null;
      const reasoning = isObject(raw.reasoning) ? raw.reasoning : null;
      const source =
        reasoning !== null && Array.isArray(reasoning.efforts)
          ? reasoning.efforts
          : Array.isArray(raw.efforts)
            ? raw.efforts
            : [];
      const efforts = [];
      for (const item of source) {
        if (!isObject(item)) continue;
        const effortId = textOf(item.id);
        if (effortId === '') continue;
        const effortName = textOf(item.name);
        efforts.push({ id: effortId, name: effortName === '' ? effortId : effortName });
      }
      const fallbackName = textOf(raw.name);
      return {
        id,
        name: fallbackName === '' ? id : fallbackName,
        defaultEffort: reasoning === null ? '' : textOf(reasoning.defaultEffort),
        efforts,
      };
    }

    /** `routes` 可能为空数组（LLM 服务未就绪），界面按空处理。 */
    function readRoutes(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        const id = textOf(item.provider);
        if (id === '') continue;
        const models = Array.isArray(item.models) ? item.models : [];
        out.push({
          id,
          name: textOf(item.name) === '' ? id : textOf(item.name),
          models: models.map(readModel).filter((model) => model !== null),
        });
      }
      return out;
    }

    function modelsOf(routes, provider) {
      const found = routes.filter((route) => route.id === provider)[0];
      return found === undefined ? [] : found.models;
    }

    function firstUsableRoute(routes) {
      for (const route of routes) {
        if (route.models.length > 0) return { provider: route.id, model: route.models[0].id };
      }
      return null;
    }

    /**
     * 服务器设置 → 界面草稿。
     *
     * 两个刻意的取舍：
     *  - `defaultRoute` 为 null 时仍保留一个空的 route 对象，这样勾上「覆盖」时
     *    可以直接落到第一个可用路由，而不是先渲染一排空下拉；
     *  - `maxDepth` 用字符串存：数字输入框清空时不能立刻跳回 1，否则没法编辑。
     */
    function draftFrom(settings, routes) {
      const fallback = firstUsableRoute(routes);
      let defaultRoute =
        settings.defaultRoute === null
          ? { provider: '', model: '', reasoningEffort: '' }
          : { ...settings.defaultRoute };
      if (defaultRoute.provider === '' && fallback !== null) {
        defaultRoute = { ...defaultRoute, provider: fallback.provider, model: fallback.model };
      } else if (
        defaultRoute.model === '' &&
        fallback !== null &&
        fallback.provider === defaultRoute.provider
      ) {
        defaultRoute = { ...defaultRoute, model: fallback.model };
      }
      return {
        enabled: settings.enabled,
        useDefault: settings.defaultRoute !== null,
        defaultRoute,
        rules: settings.rules.map((rule) => ({ ...rule })),
        maxDepth: String(settings.maxDepth),
        applyToFork: settings.applyToFork,
      };
    }

    /* ── 展示辅助 ─────────────────────────────────────────────────────────── */

    function pad2(value) {
      return value < 10 ? '0' + String(value) : String(value);
    }

    /** 本地时间 HH:MM:SS；坏值给破折号，不抛。 */
    function clockOf(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
      const at = new Date(ms);
      if (Number.isNaN(at.getTime())) return '—';
      return pad2(at.getHours()) + ':' + pad2(at.getMinutes()) + ':' + pad2(at.getSeconds());
    }

    function routeLabel(applied) {
      if (!isObject(applied)) return '';
      const provider = textOf(applied.provider);
      const model = textOf(applied.model);
      if (provider === '' && model === '') return '';
      return provider + '/' + model;
    }

    function effortLabel(applied) {
      return isObject(applied) ? textOf(applied.reasoningEffort) : '';
    }

    function targetLabel(event) {
      if (!isObject(event)) return '—';
      const member = textOf(event.memberName);
      if (member !== '') return member;
      const label = textOf(event.label);
      return label === '' ? '—' : label;
    }

    /**
     * 把宿主的 `hit` 代号翻成人话。表格的「为什么是这个模型」列直接用这个，
     * 不要暴露 `name~cheap` 这种内部写法。
     */
    function hitLabel(applied) {
      if (!isObject(applied)) return '—';
      const hit = textOf(applied.hit);
      if (hit === '') return '—';
      if (hit === '(default)') return '默认模型';
      if (hit.startsWith('member:')) return '点名指定';
      if (hit.startsWith('child:')) return '点名指定';
      if (hit === 'hit:name' || hit.startsWith('name:')) {
        return '名字匹配规则「' + hit.slice(hit.indexOf(':') + 1) + '」';
      }
      if (hit.startsWith('name~')) return '名字含「' + hit.slice(5) + '」';
      if (hit.startsWith('label~')) return '任务描述含「' + hit.slice(6) + '」';
      return hit;
    }

    /**
     * 一条规则最近命中了哪些成员。
     *
     * `hit` 的形状（宿主写进探针的）：`name:cheap`（名字精确）、`name~cheap`
     * （名字包含）、`label~cheap`（描述包含）、`member:cheap-worker`（点名）、
     * `child:<id>`（按 id 点名）、`(default)`。只有前三种是「规则」命中，
     * 点名类的要在同一成员上按规则词再比一次，否则「最近命中」会把点名结果
     * 也算成规则命中，误导用户。
     *
     * @param events - 最近委派记录（调用方传入；两个半屏各自的数据源不同，
     *   所以不能在这里引用外层变量）。
     */
    function matchesForRule(events, match) {
      const needle = match.trim().toLowerCase();
      if (needle === '' || !Array.isArray(events)) return [];
      const names = [];
      for (const event of events) {
        if (!isObject(event)) continue;
        const applied = isObject(event.applied) ? event.applied : null;
        const hit = textOf(applied?.hit);
        const name = targetLabel(event);
        if (name === '' || name === '—') continue;
        const ruleHit =
          hit === `name:${needle}` ||
          hit === `name~${needle}` ||
          hit === `label~${needle}` ||
          (hit.startsWith('member:') &&
            (name.toLowerCase().includes(needle) ||
              textOf(event.label).toLowerCase().includes(needle)));
        if (!ruleHit) continue;
        if (!names.includes(name)) names.push(name);
      }
      return names.slice(0, 4);
    }

    /* ── 成员（对话头部选择器用）：列表、固定点名、行键 ───────────────────── */

    /**
     * 一个成员/子代理行。
     *
     * 三个状态位要分清：
     *  - `live`：现在是否真的有活着的 Agent；
     *  - `pending`：这条路由是**设定值**、还没被真正跑过（宿主对未运行成员回读点名表时给 true）；
     *  - `provider/model` 为空：没有任何设定，实际是继承。
     */
    function readMember(raw) {
      if (!isObject(raw)) return null;
      const childId = textOf(raw.childId);
      const name = textOf(raw.name);
      if (childId === '' && name === '') return null;
      return {
        childId,
        name,
        isMember: raw.isMember === true,
        label: textOf(raw.label),
        provider: textOf(raw.provider),
        model: textOf(raw.model),
        reasoningEffort: textOf(raw.reasoningEffort),
        depth: Number.isSafeInteger(raw.depth) ? raw.depth : 0,
        live: raw.live !== false,
        pending: raw.pending === true,
      };
    }

    /** 行的状态徽标：待唤醒使用 → 运行中 → 未运行。 */
    function memberStatus(member) {
      if (member.pending === true) {
        return { label: '待唤醒使用', className: 'cmp-badge cmp-badgePending' };
      }
      if (member.live === true) {
        return { label: '运行中', className: 'cmp-badge cmp-badgeLive' };
      }
      return { label: '未运行', className: 'cmp-badge' };
    }

    function readMemberList(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        const member = readMember(item);
        if (member !== null) out.push(member);
      }
      return out;
    }

    /**
     * `settings.members`（点名表）的**全部键**，含已经结束、列表里看不见的成员。
     *
     * 只读成员列表清不掉这些残留：子智能体一结束就从列表里消失，而点名表里的键
     * 还在，于是历史残留越堆越多。所以管理区必须直接读这张表，而不是读成员列表。
     * 值不是合法路由时仍保留这一条（`valid: false`），否则坏数据永远删不掉。
     */
    function readFixedEntries(raw) {
      if (!isObject(raw)) return [];
      const out = [];
      for (const key of Object.keys(raw)) {
        const name = key.trim();
        if (name === '') continue;
        const route = readRoute(raw[key]);
        out.push({
          key: name,
          valid: route !== null,
          provider: route === null ? '' : route.provider,
          model: route === null ? '' : route.model,
          reasoningEffort: route === null ? '' : route.reasoningEffort,
        });
      }
      return out;
    }

    /**
     * 最近换路由失败（`lastErrors`）：`[{ time, childId, route, reason }]`，最新在前。
     *
     * 只在 `/state`、`/members`（以及保存后的 `/rules`）里下发，最多 10 条。这里只做
     * 形状归一化：`reason` 空的丢掉（没有原因可念的条目对用户没意义），`time` 非数字
     * 给 0，顺序原样保留（宿主已经是最新在前，排序交给它，前端不重排）。
     */
    function readErrors(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        const reason = textOf(item.reason);
        if (reason === '') continue;
        out.push({
          time: typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : 0,
          childId: textOf(item.childId),
          route: textOf(item.route),
          reason,
        });
      }
      return out;
    }

    /** 短 id：子智能体没有名字，用前 8 位指代，比整串会话 id 好认。 */
    function shortId(id) {
      const value = textOf(id);
      if (value.length <= 8) return value;
      return value.slice(0, 8) + '…';
    }

    /** 行键：优先子会话 id；没有 id 时退回名字。 */
    function memberKey(member) {
      return member.childId === '' ? 'name:' + member.name : 'id:' + member.childId;
    }

    /* 下拉选项：宿主的路由目录是唯一数据源。
     *
     * 返回结构化数据（不再是 `<option>` 节点）：label 是给人看的渠道名/模型名，
     * hint 是右侧等宽小字（id），两者不同才带 —— 这样不会出现「CPA Switch · Trae（cpa-trae）」
     * 那种把 id 塞进标题的括号尾巴。当前值不在目录里时由 ModelSelect 自己补一条「当前不可用」。
     */
    function providerChoiceList(routes) {
      const options = [];
      for (const route of routes) {
        options.push({
          value: route.id,
          label: route.name === route.id ? route.id : route.name,
          hint: route.name === route.id ? '' : route.id,
        });
      }
      return options;
    }

    function modelChoiceList(routes, provider) {
      const options = [];
      for (const model of modelsOf(routes, provider)) {
        options.push({
          value: model.id,
          label: model.name,
          hint: model.name === model.id ? '' : model.id,
        });
      }
      return options;
    }

    /** 某个渠道下的某个模型（含它的档位声明）；找不到给 null。 */
    function modelOf(routes, provider, model) {
      for (const item of modelsOf(routes, provider)) {
        if (item.id === model) return item;
      }
      return null;
    }

    /**
     * 档位下拉里的「自动」项。**不能用空串当值**：`readChoices` 会丢掉空值选项
     * （那样 provider/模型的空值幽灵项就没法区分），所以这里放一个哨兵值，
     * 只在本控件内部来回折算 —— 落到 state 与 HTTP 请求体里的仍是空串。
     */
    const AUTO_EFFORT = '__auto__';

    function effortSelectValue(effort) {
      const value = textOf(effort);
      return value === '' ? AUTO_EFFORT : value;
    }

    function effortFromSelect(value) {
      return textOf(value) === AUTO_EFFORT ? '' : textOf(value);
    }

    /** 档位选项：第一项「自动（由适配器挑）」，其余来自模型自己声明的 efforts。 */
    function effortChoices(efforts, defaultEffort) {
      const list = Array.isArray(efforts) ? efforts : [];
      const fallback = textOf(defaultEffort);
      const options = [{ value: AUTO_EFFORT, label: '自动（由适配器挑）', hint: '不写死档位' }];
      for (const effort of list) {
        const hint = [
          effort.id === fallback ? '模型默认' : '',
          effort.name === effort.id ? '' : effort.id,
        ]
          .filter((part) => part !== '')
          .join(' · ');
        options.push({ value: effort.id, label: effort.name, hint });
      }
      return options;
    }

    /**
     * 换渠道/模型后旧档位还能不能留。
     *
     * 旧值只在「新模型确实声明了它」时保留；新模型不声明档位、或没声明这一档，
     * 就退回空串（= 交给适配器挑）。一刀切清空会丢用户刚选的档位（AGENTS.md
     * 明令推理档位必须与路由一起确定），一刀切保留又会把不被支持的档位带到新模型上，
     * 在适配器那儿硬失败（`UNSUPPORTED_REASONING_EFFORT`）。
     */
    function reconcileEffort(routes, provider, model, current) {
      const value = textOf(current);
      if (value === '') return '';
      const found = modelOf(routes, provider, model);
      if (found === null) return '';
      return found.efforts.some((effort) => effort.id === value) ? value : '';
    }

    /** 模型下拉按当前渠道分组：标题就是渠道名，一眼知道这批模型属于谁。 */
    function modelChoiceGroups(routes, provider) {
      const models = modelChoiceList(routes, provider);
      if (models.length === 0) return [];
      const channel = routes.filter((route) => route.id === provider)[0];
      const label = channel === undefined ? provider : channel.name;
      return [{ label: label === provider ? provider : label, options: models }];
    }

    /* ── 图标：内联 SVG，颜色走 currentColor，不引入任何资源文件 ───────────── */

    function chevronIcon(open) {
      return h(
        'svg',
        {
          className: open ? 'mds-chevron mds-chevronOpen' : 'mds-chevron',
          viewBox: '0 0 12 12',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3 4.5L6 7.5L9 4.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      );
    }

    function checkIcon() {
      return h(
        'svg',
        { className: 'mds-check', viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.5 6.2L5 8.7L9.5 3.4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      );
    }

    /* ── ModelSelect：自绘下拉（原生 select 的弹层无法用主题定制） ─────────── */

    let selectSeq = 0;

    function readChoices(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (!isObject(item)) continue;
        const value = textOf(item.value);
        if (value === '') continue;
        out.push({
          value,
          label: textOf(item.label) === '' ? value : textOf(item.label),
          hint: textOf(item.hint),
        });
      }
      return out;
    }

    function readChoiceGroups(raw) {
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const group of raw) {
        if (!isObject(group)) continue;
        const options = readChoices(group.options);
        if (options.length === 0) continue;
        out.push({ label: textOf(group.label), options });
      }
      return out;
    }

    /**
     * 受控下拉。`value` + `onChange(value)`，不持有业务状态。
     *
     * 弹层用 `position: fixed`：它挂在面板的滚动容器里，absolute 会被裁掉。
     * 因此打开时测量触发器位置，监听 window 的 resize/scroll 重新贴合。
     */
    function ModelSelect(props) {
      const p = isObject(props) ? props : {};
      const value = textOf(p.value);
      const disabled = p.disabled === true;
      const placeholder = textOf(p.placeholder) === '' ? '请选择' : textOf(p.placeholder);
      const emptyHint = textOf(p.emptyHint);
      const ariaLabel = textOf(p.ariaLabel);
      const testId = textOf(p.testId);
      const className = textOf(p.className);

      const baseGroups = readChoiceGroups(p.groups);
      const flatOptions = readChoices(p.options);
      const groups =
        baseGroups.length > 0
          ? baseGroups
          : flatOptions.length > 0
            ? [{ label: '', options: flatOptions }]
            : [];

      /* 量「最宽选项」的长度，用来决定弹层宽度。
         写死宽度必然在某些机器上截断：渠道名与 provider id 由运行环境决定。
         无 document 或异常时返回 0，调用方退回固定下限。 */
      function measureWidestOption() {
        if (typeof document === 'undefined') return 0;
        const entries = [];
        for (const group of groups) {
          for (const option of group.options) {
            entries.push({ label: option.label, hint: option.hint });
          }
        }
        if (entries.length === 0) return 0;
        try {
          const probe = document.createElement('div');
          probe.style.cssText =
            'position:absolute;left:-9999px;top:-9999px;visibility:hidden;display:flex;align-items:center;gap:6px;padding:0 6px;font-size:13px;line-height:18px;white-space:nowrap';
          const labelEl = document.createElement('span');
          const hintEl = document.createElement('span');
          hintEl.style.cssText =
            'font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
          probe.appendChild(labelEl);
          probe.appendChild(hintEl);
          document.body.appendChild(probe);
          let widest = 0;
          for (const entry of entries) {
            labelEl.textContent = entry.label === undefined ? '' : String(entry.label);
            hintEl.textContent = entry.hint === undefined ? '' : String(entry.hint);
            const width = probe.getBoundingClientRect().width;
            if (width > widest) widest = width;
          }
          probe.remove();
          // 加上勾选列（12）、弹层内边距（4*2）与左右留白。
          return Math.ceil(widest) + 12 + 8 + 10;
        } catch {
          return 0;
        }
      }

      // 当前值不在目录里也要看得见：补一条带「当前不可用」提示的幽灵项。
      let allValues = [];
      for (const group of groups) for (const option of group.options) allValues.push(option.value);
      const view =
        value !== '' && allValues.indexOf(value) < 0
          ? [{ label: '', options: [{ value, label: value, hint: '当前不可用' }] }].concat(groups)
          : groups;

      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(-1);
      const [rect, setRect] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const idRef = React.useRef(null);
      if (idRef.current === null) {
        selectSeq += 1;
        idRef.current = 'mds-' + String(selectSeq);
      }
      const baseId = idRef.current;

      const needle = query.trim().toLowerCase();
      const filtered = [];
      for (const group of view) {
        const options =
          needle === ''
            ? group.options
            : group.options.filter(
                (option) =>
                  option.label.toLowerCase().indexOf(needle) >= 0 ||
                  option.value.toLowerCase().indexOf(needle) >= 0,
              );
        if (options.length > 0) filtered.push({ label: group.label, options });
      }
      const flat = [];
      for (const group of filtered) for (const option of group.options) flat.push(option);
      let total = 0;
      for (const group of view) total += group.options.length;
      const showSearch = total >= 8;

      let current = null;
      for (const group of view) {
        for (const option of group.options) if (option.value === value) current = option;
      }
      const displayLabel =
        value === ''
          ? placeholder
          : current === null
            ? value
            : current.label;

      function measure() {
        const trigger = triggerRef.current;
        if (
          trigger === null ||
          trigger === undefined ||
          typeof trigger.getBoundingClientRect !== 'function'
        ) {
          return;
        }
        if (
          typeof window === 'undefined' ||
          !Number.isFinite(window.innerWidth) ||
          !Number.isFinite(window.innerHeight)
        ) {
          return;
        }
        const box = trigger.getBoundingClientRect();
        /* 宽度策略：**不跟着触发器走**。触发器常常只有 150–180px（批量条、规则行），
           跟着它会把「CPA Switch · Trae」+ provider id 截成 `CPA Swit… · cpa-trae`。
           这里给一个宽松的区间：至少 240，最多 380，且不超过视口。
           触发器更宽时（例如整行下拉）才跟着变宽。 */
        const viewportCap = Math.max(200, window.innerWidth - 16);
        /* 先按**实测内容**算，再夹到合理区间。
           跟着触发器走会截断（触发器常只有 150–180px）；只给固定下限也会截断
           （「CPA Switch · WorkBuddy」+ `cpa-workbuddy` 实测要 251px）。
           量不到内容时才退回 240 下限。 */
        const wanted = Math.max(240, box.width, measureWidestOption());
        const width = Math.min(viewportCap, Math.min(380, wanted));
        const left = Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8));
        const below = window.innerHeight - box.bottom - 8;
        const above = box.top - 8;
        const up = below < 200 && above > below;
        const maxHeight = Math.max(120, Math.min(260, up ? above : below));
        setRect({ up, width, left, top: box.bottom + 4, bottom: window.innerHeight - box.top + 4, maxHeight });
      }

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = isObject(event) ? event.target : null;
          const root = rootRef.current;
          const panel = panelRef.current;
          const inRoot =
            root !== null && typeof root.contains === 'function' && root.contains(target);
          const inPanel =
            panel !== null && typeof panel.contains === 'function' && panel.contains(target);
          if (inRoot || inPanel) return;
          setOpen(false);
        };
        measure();
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('pointerdown', onPointerDown, true);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure);
          window.addEventListener('scroll', measure, true);
        }
        return () => {
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointerdown', onPointerDown, true);
          }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
          }
        };
      }, [open]);

      // 打开时把焦点交给搜索框（有的话），并把高亮落到当前值上。
      React.useEffect(() => {
        if (!open) return;
        let index = -1;
        for (let at = 0; at < flat.length; at += 1) {
          if (flat[at].value === value) index = at;
        }
        setActive(index >= 0 ? index : flat.length > 0 ? 0 : -1);
        const search = searchRef.current;
        const trigger = triggerRef.current;
        if (search !== null && search !== undefined && typeof search.focus === 'function') {
          search.focus();
        } else if (trigger !== null && trigger !== undefined) {
          /* 焦点本来就留在触发器上，列表用键盘已在它身上处理。 */
        }
        // flat 由 value/query 派生，这里只应在「打开」这一下跑一次。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open]);

      function focusTrigger() {
        const trigger = triggerRef.current;
        if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') {
          trigger.focus();
        }
      }

      function close() {
        setOpen(false);
        setQuery('');
      }

      function choose(option) {
        if (option === undefined || option === null) return;
        if (typeof p.onChange === 'function') p.onChange(option.value);
        setOpen(false);
        setQuery('');
        focusTrigger();
      }

      function onKeyDown(event) {
        if (!isObject(event)) return;
        const key = event.key;
        if (key === 'Escape') {
          if (!open) return;
          event.preventDefault();
          close();
          focusTrigger();
          return;
        }
        if (key === 'Tab') {
          if (open) close();
          return;
        }
        if (disabled) return;
        if (!open) {
          if (key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
          return;
        }
        if (key === 'ArrowDown') {
          event.preventDefault();
          setActive((current) => (flat.length === 0 ? -1 : (current + 1) % flat.length));
          return;
        }
        if (key === 'ArrowUp') {
          event.preventDefault();
          setActive((current) =>
            flat.length === 0 ? -1 : current <= 0 ? flat.length - 1 : current - 1,
          );
          return;
        }
        if (key === 'Home') {
          event.preventDefault();
          setActive(flat.length === 0 ? -1 : 0);
          return;
        }
        if (key === 'End') {
          event.preventDefault();
          setActive(flat.length === 0 ? -1 : flat.length - 1);
          return;
        }
        if (key === 'Enter') {
          event.preventDefault();
          choose(flat[active]);
        }
      }

      const panelStyle =
        rect === null
          ? { position: 'fixed', top: '56px', left: '8px', width: '240px', maxHeight: '260px' }
          : rect.up
            ? {
                position: 'fixed',
                bottom: String(rect.bottom) + 'px',
                left: String(rect.left) + 'px',
                width: String(rect.width) + 'px',
                maxHeight: String(rect.maxHeight) + 'px',
              }
            : {
                position: 'fixed',
                top: String(rect.top) + 'px',
                left: String(rect.left) + 'px',
                width: String(rect.width) + 'px',
                maxHeight: String(rect.maxHeight) + 'px',
              };

      let optionIndex = -1;
      const rows = [];
      for (let gi = 0; gi < filtered.length; gi += 1) {
        const group = filtered[gi];
        if (group.label !== '') {
          rows.push(
            h(
              'div',
              { className: 'mds-groupTitle', key: 'group:' + String(gi), role: 'presentation' },
              group.label,
            ),
          );
        }
        for (const option of group.options) {
          optionIndex += 1;
          const at = optionIndex;
          const selected = option.value === value;
          rows.push(
            h(
              'button',
              {
                type: 'button',
                role: 'option',
                key: 'option:' + option.value,
                id: baseId + '-opt-' + String(at),
                className: [
                  'mds-option',
                  selected ? 'mds-optionSelected' : '',
                  at === active ? 'mds-optionActive' : '',
                ]
                  .filter((name) => name !== '')
                  .join(' '),
                'aria-selected': selected,
                'data-option-value': option.value,
                title: option.hint === '' ? option.label : option.label + ' · ' + option.hint,
                ref: (node) => {
                  if (at !== active || node === null || node === undefined) return;
                  if (typeof node.scrollIntoView === 'function') {
                    node.scrollIntoView({ block: 'nearest' });
                  }
                },
                onMouseEnter: () => setActive(at),
                onClick: () => choose(option),
              },
              selected ? checkIcon() : h('span', { className: 'mds-checkSpacer' }),
              h('span', { className: 'mds-optionLabel' }, option.label),
              option.hint === '' ? null : h('span', { className: 'mds-optionHint' }, option.hint),
            ),
          );
        }
      }

      const panel = open
        ? h(
            'div',
            {
              className: 'mds-panel',
              id: baseId + '-panel',
              role: 'listbox',
              ref: panelRef,
              style: panelStyle,
              'aria-label': ariaLabel === '' ? undefined : ariaLabel,
              onKeyDown,
            },
            showSearch
              ? h(
                  'div',
                  { className: 'mds-searchWrap' },
                  h('input', {
                    type: 'text',
                    className: 'mds-search',
                    ref: searchRef,
                    value: query,
                    placeholder: '搜索模型',
                    'aria-label': '搜索模型',
                    onChange: (event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    },
                  }),
                )
              : null,
            h(
              'div',
              { className: 'mds-list' },
              flat.length === 0
                ? h(
                    'div',
                    { className: 'mds-empty' },
                    total === 0 ? (emptyHint === '' ? '没有可选项' : emptyHint) : '没有匹配的选项',
                  )
                : rows,
            ),
          )
        : null;

      return h(
        'div',
        { className: className === '' ? 'mds' : 'mds ' + className, ref: rootRef },
        textOf(p.label) === ''
          ? null
          : h('span', { className: 'mds-label' }, textOf(p.label)),
        h(
          'button',
          {
            type: 'button',
            className: 'mds-trigger',
            ref: triggerRef,
            role: 'combobox',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-controls': open ? baseId + '-panel' : undefined,
            'aria-activedescendant': open && active >= 0 ? baseId + '-opt-' + String(active) : undefined,
            'aria-label': ariaLabel === '' ? undefined : ariaLabel,
            'data-testid': testId === '' ? undefined : testId,
            'data-value': value,
            disabled,
            onClick: () => {
              if (disabled) return;
              if (open) close();
              else setOpen(true);
            },
            onKeyDown,
          },
          h(
            'span',
            { className: value === '' ? 'mds-value mds-valuePlaceholder' : 'mds-value' },
            displayLabel,
          ),
          chevronIcon(open),
        ),
        panel,
      );
    }

    function slidersIcon() {
      return h(
        'svg',
        { className: 'cmp-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M2.5 5h5.5M2.5 11h3.5',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          fill: 'none',
        }),
        h('circle', {
          cx: 10.5,
          cy: 5,
          r: 1.6,
          stroke: 'currentColor',
          strokeWidth: 1.3,
          fill: 'none',
        }),
        h('circle', {
          cx: 8.5,
          cy: 11,
          r: 1.6,
          stroke: 'currentColor',
          strokeWidth: 1.3,
          fill: 'none',
        }),
      );
    }

    /** 垃圾桶：只用于「删除这条规则」，语义最接近的既有图标形状。 */
    function trashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 15,
          height: 15,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3 4.5h10M6.5 4.5V3.2h3v1.3M4.6 4.5l.6 8.1h5.6l.6-8.1M6.9 6.8v3.6M9.1 6.8v3.6',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      );
    }


    /** 折叠箭头：展开时转 90°。 */
    function caretIcon(isOpen) {
      return h(
        'svg',
        {
          className: isOpen ? 'cmp-caret cmp-caretOpen' : 'cmp-caret',
          viewBox: '0 0 10 10',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M3 1.5L6.5 5L3 8.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      );
    }

    function memberGlyph(isMember) {
      if (isMember) {
        return h(
          'svg',
          {
            className: 'cmp-rowIcon',
            viewBox: '0 0 16 16',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('circle', {
            cx: 8,
            cy: 5.5,
            r: 2.4,
            stroke: 'currentColor',
            strokeWidth: 1.2,
            fill: 'none',
          }),
          h('path', {
            d: 'M3.5 13c0-2.2 2-3.6 4.5-3.6s4.5 1.4 4.5 3.6',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
            fill: 'none',
          }),
        );
      }
      return h(
        'svg',
        { className: 'cmp-rowIcon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', {
          x: 2.8,
          y: 3.4,
          width: 10.4,
          height: 9.2,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.2,
          fill: 'none',
        }),
        h('circle', { cx: 6.2, cy: 8, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 9.8, cy: 8, r: 0.9, fill: 'currentColor' }),
      );
    }

    /* ── 样式：只用主题 token，颜色零硬编码 ───────────────────────────────── */

    const CSS = [
      '.cm-card{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.cm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}',
      '.cm-headText{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.cm-title{margin:0;font-size:15px;font-weight:500;line-height:22px}',
      '.cm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.cm-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.cm-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
      '.cm-section{display:flex;flex-direction:column;gap:10px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.cm-sectionTitle{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.cm-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      /* 字段内部：输入框和下拉撑满字段宽度，且不参与外层 flex 伸展 ——
         .cm-match 的 `flex:1 1 150px` 在纵向 flex 里会变成 150px 高的大方块。 */
      '.cm-field .cm-input,.cm-field .cm-match{flex:none;width:100%}',
      '.cm-field .mds{width:100%;min-width:0;align-self:stretch}',
      '.cm-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.cm-fieldHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.cm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cm-rules{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.cm-ruleCard{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.cm-ruleTop{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cm-ruleMeta{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.cm-ruleMetaHit{color:var(--dsw-alias-label-secondary)}',
      /* 规则试算：一行输入 + 按钮，下面一行结果。尺寸沿用 .cm-input / .cm-btn，不另起一套。 */
      '.cm-probe{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cm-probeInput{flex:1 1 180px}',
      '.cm-probeResult{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.cm-probeHit{color:var(--dsw-alias-state-success-primary)}',
      '.cm-probeNone{color:var(--dsw-alias-label-tertiary)}',
      '.cm-probeErr{color:var(--dsw-alias-state-error-primary)}',
      '.cm-probeWait{color:var(--dsw-alias-state-warn-label)}',
      '.cm-iconBtn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.cm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}',
      '.cm-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cm-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.cm-check input{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary)}',
      '.cm-input{box-sizing:border-box;height:30px;min-width:0;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.cm-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.cm-input:hover{border-color:var(--dsw-alias-border-l3)}',
      '.cm-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cm-input:disabled{opacity:.45;cursor:not-allowed}',
      '.cm-match{flex:1 1 150px}',
      '.cm-provider{flex:0 1 160px}',
      '.cm-model{flex:0 1 200px}',
      '.cm-effort{flex:0 1 160px}',
      '.cm-depth{width:84px}',
      '.cm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s}',
      '.cm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.cm-btn:disabled{opacity:.5;cursor:default}',
      '.cm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cm-btnPrimary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-layer-1)}',
      '.cm-btnPrimary:hover:not(:disabled){border-color:var(--dsw-alias-button-primary-hover);background:var(--dsw-alias-button-primary-hover)}',
      '.cm-btnDanger{color:var(--dsw-alias-state-error-primary)}',
      '.cm-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.cm-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
      '.cm-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.cm-empty{padding:8px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.cm-skeleton{height:12px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}',
      '.cm-skeletonShort{width:45%}',
      '.cm-switchTrack{position:relative;box-sizing:border-box;flex:none;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.cm-switchTrack[aria-checked="true"]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill)}',
      '.cm-switchTrack:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cm-switchKnob{position:absolute;top:2px;left:2px;display:block;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .12s}',
      '.cm-switchTrack[aria-checked="true"] .cm-switchKnob{transform:translateX(14px)}',
      '.cm-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}',
      '.cm-table th{padding:6px 10px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left;white-space:nowrap}',
      '.cm-table td{padding:6px 10px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);vertical-align:top}',
      '.cm-table tr:last-child td{border-bottom:0}',
      '.cm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.cm-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',

      /* ── 对话头部的「模型」按钮 + 成员选择面板 ─────────────────────────── */
      '.cmp-root{position:relative;display:inline-flex;align-items:center}',
      '.cmp-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background-color .12s,color .12s}',
      '.cmp-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cmp-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cmp-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-icon{display:block;flex:none;width:13px;height:13px}',
      '.cmp-panel{box-sizing:border-box;position:fixed;z-index:1000;display:flex;flex-direction:column;gap:8px;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.cmp-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.cmp-headTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}',
      '.cmp-close{box-sizing:border-box;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:16px;cursor:pointer}',
      '.cmp-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cmp-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.cmp-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}',
      '.cmp-notice{margin:0;font-size:12px;line-height:18px}',
      '.cmp-noticeOk{color:var(--dsw-alias-state-success-primary)}',
      '.cmp-noticeErr{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.cmp-list{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.cmp-row{display:flex;flex-direction:column;min-width:0;border-radius:6px}',
      '.cmp-rowBtn{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.cmp-rowBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.cmp-rowBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-rowBtn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.cmp-rowIcon{display:block;flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.cmp-rowMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
      '.cmp-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cmp-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cmp-model{flex:none;max-width:46%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cmp-modelNone{color:var(--dsw-alias-label-tertiary)}',
      '.cmp-badge{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.cmp-badgeLive{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.cmp-badgePending{border-color:var(--dsw-alias-state-warn-label);color:var(--dsw-alias-state-warn-label)}',
      '.cmp-editor{display:flex;flex-direction:column;gap:8px;margin:2px 0 6px;padding:8px 6px 10px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.cmp-fields{display:flex;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cmp-input{box-sizing:border-box;height:30px;min-width:0;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.cmp-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.cmp-input:hover{border-color:var(--dsw-alias-border-l3)}',
      '.cmp-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-input:disabled{opacity:.45;cursor:not-allowed}',
      '.cmp-provider{flex:0 1 150px}',
      '.cmp-modelSel{flex:0 1 190px}',
      '.cmp-effort{flex:1 1 130px}',
      '.cmp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cmp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s}',
      '.cmp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.cmp-btn:disabled{opacity:.5;cursor:default}',
      '.cmp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-btnPrimary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-layer-1)}',
      '.cmp-btnPrimary:hover:not(:disabled){border-color:var(--dsw-alias-button-primary-hover);background:var(--dsw-alias-button-primary-hover)}',
      '.cmp-empty{padding:10px 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

      /* ── 面板里的「新建队友 / 子智能体」表单 ─────────────────────────── */
      '.cmp-create{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.cmp-createHead{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:600;line-height:18px;text-align:left;cursor:pointer}',
      '.cmp-createHead:hover{color:var(--dsw-alias-label-primary)}',
      '.cmp-createHead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-caret{display:block;flex:none;width:10px;height:10px;transition:transform .12s;color:var(--dsw-alias-label-tertiary)}',
      '.cmp-caretOpen{transform:rotate(90deg)}',
      '.cmp-kinds{display:flex;gap:6px;flex-wrap:wrap}',
      '.cmp-createBody{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.cmp-kind{box-sizing:border-box;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.cmp-kind:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cmp-kind[aria-pressed="true"]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-layer-1)}',
      '.cmp-kind:disabled{opacity:.5;cursor:default}',
      '.cmp-kind:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.cmp-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.cmp-textarea{box-sizing:border-box;width:100%;min-height:56px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;resize:vertical}',
      '.cmp-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.cmp-textarea:hover{border-color:var(--dsw-alias-border-l3)}',
      '.cmp-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cmp-textarea:disabled{opacity:.45;cursor:not-allowed}',
      '.cmp-inputWide{width:100%}',
      '.cmp-fieldErr{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
      '.cmp-guide{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

      /* ── 批量：把本会话全部成员换成同一个模型 ─────────────────────────── */
      '.cmp-bulk{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.cmp-bulkRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cmp-bulkLabel{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.cmp-bulkResult{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.cmp-bulkWarn{color:var(--dsw-alias-state-warn-label)}',
      '.cmp-bulkErr{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.cmp-bulkNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      /* 失败红条：容器沿用 .cmp-bulk/.cmp-create 那套（border-l1 + layer-1），
         语义只靠 .cmp-noticeErr 的红字表达，不引入新的视觉语言。 */
      '.cmp-errorBar{display:flex;flex-direction:column;gap:6px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.cmp-errorRow{display:flex;align-items:flex-start;gap:8px;min-width:0}',
      '.cmp-errorText{flex:1 1 auto;min-width:0;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.cmp-errorList{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;min-width:0}',
      '.cmp-errorItem{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.cmp-errorTime{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.cmp-errorBarBtn{flex:none;height:22px;padding:0 6px;font-size:11px;line-height:20px}',
      /* 「本对话默认」块：标题行（标签 + 说明）+ 一个下拉，和批量条同一层级。 */
      '.cmp-sessionBlock{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cmp-sessionHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
      '.cmp-sessionLabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.cmp-sessionBlock .mds{width:100%;min-width:0;align-self:stretch}',

      /* ── 点名表管理（面板最底部的折叠块） ─────────────────────────────── */
      '.cmp-pins{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.cmp-pinHead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.cmp-pinHead .cmp-createHead{flex:1 1 auto;min-width:0}',
      '.cmp-pinRow{display:flex;align-items:center;gap:8px;min-width:0;padding:2px 0}',
      '.cmp-pinKey{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cmp-pinStale{color:var(--dsw-alias-state-warn-label)}',
      '.cmp-pinModel{flex:0 1 52%;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
      '.cmp-pinBtn{flex:none;height:26px;padding:0 8px;font-size:12px}',

      /* ── 跨面板 toast（挂 framework 的 shell.overlay） ─────────────────── */
      /* shell.overlay 的图层本身是 pointer-events:none（点得穿），容器必须保持 none，
         只有每条 toast 自己开 auto，否则一整层会挡住下面的界面。 */
      '.cmt-layer{position:fixed;top:12px;right:16px;z-index:2000;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 32px));pointer-events:none}',
      '.cmt-toast{box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;pointer-events:auto}',
      '.cmt-toastOk{border-color:var(--dsw-alias-state-success-primary)}',
      '.cmt-toastErr{border-color:var(--dsw-alias-state-error-primary)}',
      '.cmt-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
      '.cmt-toastOk .cmt-text{color:var(--dsw-alias-state-success-primary)}',
      '.cmt-toastErr .cmt-text{color:var(--dsw-alias-state-error-primary)}',
      '.cmt-close{box-sizing:border-box;flex:none;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:16px;cursor:pointer;pointer-events:auto}',
      '.cmt-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.cmt-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',

      /* ── ModelSelect：自绘下拉（触发器 + 固定定位弹层） ───────────────── */
      /* `align-self:flex-start` + `flex:none` 是关键：父级是纵向 flex，
         默认 stretch 会把 .mds 拉到和兄弟一样高（曾导致规则行三字段参差）。
         不要给 .mds-panel 加 `contain:size` —— 那会让弹层不再被内容撑开，
         高度塌成 0，只剩一条搜索框的缝。 */
      '.mds{position:relative;display:flex;flex-direction:column;gap:3px;min-width:0;max-width:100%;height:auto;align-self:flex-start;flex:none}',
      '.mds-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.mds-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:30px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background-color .12s,border-color .12s,box-shadow .12s}',
      '.mds-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mds-trigger[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary)}',
      '.mds-trigger:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover)}',
      '.mds-trigger:disabled{opacity:.45;cursor:not-allowed}',
      '.mds-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mds-valuePlaceholder{color:var(--dsw-alias-label-tertiary)}',
      '.mds-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary);transition:transform .12s}',
      '.mds-chevronOpen{transform:rotate(180deg)}',
      '.mds-panel{box-sizing:border-box;position:fixed;z-index:60;display:flex;flex-direction:column;overflow:hidden;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}',
      '.mds-searchWrap{position:sticky;top:0;z-index:1;flex:none;padding:2px 2px 6px;background:var(--dsw-alias-bg-layer-3)}',
      '.mds-search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '.mds-search::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.mds-search:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.mds-list{display:flex;flex-direction:column;gap:2px;overflow-y:auto;min-height:0;padding-bottom:2px}',
      '.mds-groupTitle{padding:8px 6px 4px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.mds-option{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;height:30px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}',
      '.mds-option:hover,.mds-optionActive{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mds-optionSelected{color:var(--dsw-alias-brand-primary)}',
      '.mds-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.mds-check{flex:none;width:12px;height:12px}',
      '.mds-checkSpacer{flex:none;width:12px;height:12px}',
      /* 标签：占满剩余宽度并截断；右侧 id 后缀按内容走，给标签至少留 40%。
         以前后缀卡死 46% 上限，`cpa-workbuddy` 会被截成 `cpa-workbu…`。 */
      '\.mds-optionLabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '\.mds-optionHint{flex:0 0 auto;min-width:0;max-width:60%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mds-empty{padding:10px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
    ].join('');

    function styleTag() {
      return h('style', { key: 'cm-style', dangerouslySetInnerHTML: { __html: CSS } });
    }

    /* ── 错误边界：任何渲染异常都退化成一行提示，不影响插件页其他部分 ────── */

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try {
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[dsh-switchboard] 设置卡片渲染失败：', error);
          }
        } catch {
          /* 日志失败也不许再抛 */
        }
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'cm-card' },
            styleTag(),
            h('div', { className: 'cm-title' }, '子智能体模型'),
            h('div', { className: 'cm-err' }, '设置卡片渲染失败：' + messageOf(this.state.error)),
            h(
              'div',
              { className: 'cm-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'cm-btn',
                  onClick: () => this.setState({ error: null }),
                },
                '重试渲染',
              ),
            ),
          );
        }
        return this.props.children === undefined || this.props.children === null
          ? null
          : this.props.children;
      }
    }

    /* ── 卡片主体 ─────────────────────────────────────────────────────────── */

    function Body() {
      const [phase, setPhase] = React.useState('loading'); // loading | ready | error
      const [loadError, setLoadError] = React.useState('');
      const [draft, setDraft] = React.useState(null);
      const [routes, setRoutes] = React.useState([]);
      const [recent, setRecent] = React.useState(undefined); // undefined=加载中 null=不可用 array=有数据
      const [saving, setSaving] = React.useState(false);
      const [feedback, setFeedback] = React.useState(null);
      const [reloadTick, setReloadTick] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setPhase('loading');
        setLoadError('');
        (async () => {
          const response = await request(STATE_PATH);
          if (!alive) return;
          const payload = response.data;
          if (response.ok && isObject(payload) && payload.ok === true) {
            const settings = readSettings(payload.settings);
            const routeList = readRoutes(payload.routes);
            setRoutes(routeList);
            setDraft(draftFrom(settings, routeList));
            setPhase('ready');
            return;
          }
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setLoadError(
            detail === '' ? '无法读取设置（HTTP ' + String(response.status) + '）' : detail,
          );
          setPhase('error');
        })();
        return () => {
          alive = false;
        };
      }, [reloadTick]);

      // 最近委派是锦上添花：端点没上线（404）、形状不对、解析失败都只影响这一块。
      React.useEffect(() => {
        let alive = true;
        (async () => {
          const response = await request(RECENT_PATH);
          if (!alive) return;
          const payload = response.data;
          if (
            response.ok !== true ||
            !isObject(payload) ||
            payload.ok !== true ||
            !Array.isArray(payload.events)
          ) {
            setRecent(null);
            return;
          }
          setRecent(payload.events);
        })();
        return () => {
          alive = false;
        };
      }, [reloadTick]);

      function patchDraft(patch) {
        setDraft((current) => (current === null ? current : { ...current, ...patch }));
      }

      function updateRule(index, patch) {
        setDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                rules: current.rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)),
              },
        );
      }

      function addRule() {
        setDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                rules: current.rules.concat([
                  { match: '', provider: '', model: '', reasoningEffort: '' },
                ]),
              },
        );
      }

      function removeRule(index) {
        setDraft((current) =>
          current === null
            ? current
            : { ...current, rules: current.rules.filter((_rule, at) => at !== index) },
        );
      }

      /**
       * 默认模型下拉：把「渠道 + 模型」压成一个值 `provider|model`，第一项是
       * 「继承主 Agent」（值为空串 ⇒ 提交 `defaultRoute: null`）。这样一个控件
       * 说清「要么继承，要么指定」，不用先勾一个双重否定的勾选框。
       */
      function inheritFirstOptions() {
        const options = [{ value: '', label: '继承主 Agent（默认）', hint: '不干预' }];
        for (const route of routes) {
          for (const model of modelsOf(routes, route.id)) {
            options.push({
              value: route.id + '|' + model.id,
              label: model.name || model.id,
              hint: route.name === route.id ? route.id : route.name,
            });
          }
        }
        return options;
      }

      function chooseDefault(value) {
        if (value === '') {
          setDraft((current) =>
            current === null ? current : { ...current, useDefault: false },
          );
          return;
        }
        const at = value.indexOf('|');
        if (at <= 0) return;
        const provider = value.slice(0, at);
        const model = value.slice(at + 1);
        if (provider === '' || model === '') return;
        setDraft((current) => ({
          ...(current === null ? {} : current),
          useDefault: true,
          defaultRoute: {
            provider,
            model,
            reasoningEffort: current === null ? '' : current.defaultRoute.reasoningEffort,
          },
        }));
      }

      /** 摘要里用的短模型名：只显示模型 id，渠道放括号里更省地方。 */
      function shortModel(provider, model) {
        if (model === '') return provider === '' ? '继承主 Agent' : provider;
        return model;
      }

      /** 卡片头的摘要：规则几条、默认是什么。用户一眼知道当前配置的形状。 */
      function summaryText() {
        if (draft === null) return '';
        const count = draft.rules.filter(
          (rule) => rule.match.trim() !== '' && rule.provider !== '' && rule.model !== '',
        ).length;
        const rulePart = count === 0 ? '没有规则' : count + ' 条规则';
        const defaultPart = draft.useDefault
          ? shortModel(draft.defaultRoute.provider, draft.defaultRoute.model)
          : '继承主 Agent';
        const offPart = draft.enabled ? '' : ' · 已停用';
        return rulePart + ' · 默认：' + defaultPart + offPart;
      }

      async function save() {
        if (draft === null || saving) return;
        setSaving(true);
        setFeedback(null);
        const rules = [];
        for (const rule of draft.rules) {
          const match = rule.match.trim();
          if (match === '' || rule.provider === '' || rule.model === '') continue;
          rules.push({
            match,
            provider: rule.provider,
            model: rule.model,
            ...(rule.reasoningEffort.trim() === ''
              ? {}
              : { reasoningEffort: rule.reasoningEffort.trim() }),
          });
        }
        const effort = draft.defaultRoute.reasoningEffort.trim();
        const defaultRoute =
          draft.useDefault && draft.defaultRoute.provider !== '' && draft.defaultRoute.model !== ''
            ? {
                provider: draft.defaultRoute.provider,
                model: draft.defaultRoute.model,
                ...(effort === '' ? {} : { reasoningEffort: effort }),
              }
            : null;
        const depth = Number.parseInt(draft.maxDepth, 10);
        const body = {
          enabled: draft.enabled,
          rules,
          defaultRoute,
          maxDepth: Number.isSafeInteger(depth) ? Math.max(0, Math.min(9, depth)) : 1,
          applyToFork: draft.applyToFork,
        };
        const response = await request(RULES_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setSaving(false);
        if (response.ok && isObject(response.data) && response.data.ok === true) {
          setDraft(draftFrom(readSettings(response.data.settings), routes));
          setFeedback({ kind: 'ok', text: '已保存，下一次委派生效' });
          return;
        }
        const message = isObject(response.data) ? textOf(response.data.error) : '';
        setFeedback({
          kind: 'error',
          text: message === '' ? '保存失败（HTTP ' + String(response.status) + '）' : message,
        });
      }

      function providerOptions(current) {
        return providerChoiceList(routes);
      }

      function modelOptions(provider) {
        return modelChoiceGroups(routes, provider);
      }



      if (phase === 'error') {
        return h(
          'div',
          { className: 'cm-card' },
          styleTag(),
          h('div', { className: 'cm-title' }, '子智能体模型'),
          h('div', { className: 'cm-err' }, loadError),
          h(
            'div',
            { className: 'cm-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'cm-btn',
                onClick: () => setReloadTick((tick) => tick + 1),
              },
              '重新加载',
            ),
          ),
        );
      }

      /* 加载中：骨架 + 文字，避免卡片高度跳变。 */
      if (phase === 'loading' || draft === null) {
        return h(
          'div',
          { className: 'cm-card' },
          styleTag(),
          h('div', { className: 'cm-title' }, '子智能体模型'),
          h('div', { className: 'cm-skeleton' }),
          h('div', { className: 'cm-skeleton cm-skeletonShort' }),
          h('div', { className: 'cm-hint' }, '加载中…'),
        );
      }

      /* 规则行：上排「匹配词 + 渠道 + 模型 + 档位 + 删除」，下排告出这条规则最近命中了谁。
         没有这行提示，用户根本看不出一条规则到底作用在哪个成员身上。
         档位（reasoningEffort）必须能在这里编辑：路由和档位是一条命，见 AGENTS.md。 */
      const ruleRows = draft.rules.map((rule, index) => {
        const matched = matchesForRule(recent, rule.match);
        const ruleModel = modelOf(routes, rule.provider, rule.model);
        const effortList = ruleModel === null ? [] : ruleModel.efforts;
        const effortDisabled = rule.provider === '' || rule.model === '' || effortList.length === 0;
        const line = probeLine(index);
        const metaText =
          rule.match.trim() === ''
            ? '填一个词，队友名或任务描述里含它就会命中'
            : matched.length === 0
              ? '还没有命中过任何成员'
              : '最近命中：';
        return h(
          'div',
          { className: 'cm-ruleCard', key: 'rule:' + String(index) },
          h(
            'div',
            { className: 'cm-ruleTop' },
            h(
              'div',
              { className: 'cm-field', style: { flex: '1 1 140px' } },
              h('span', { className: 'cm-fieldLabel' }, '名字或任务描述里含'),
              h('input', {
                type: 'text',
                className: 'cm-input cm-match',
                value: rule.match,
                placeholder: '例如 cheap、审查',
                'aria-label': '规则匹配词',
                onChange: (event) => updateRule(index, { match: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'cm-field', style: { flex: '1 1 180px' } },
              h('span', { className: 'cm-fieldLabel' }, '就用这个模型'),
              h(ModelSelect, {
                className: 'cm-provider',
                value: rule.provider,
                options: providerOptions(),
                placeholder: '选择渠道',
                emptyHint: '没有可用的渠道（LLM 服务未就绪）',
                ariaLabel: '规则 provider',
                testId: 'provider-select',
                onChange: (value) => {
                  const models = modelsOf(routes, value);
                  const model = models.length > 0 ? models[0].id : '';
                  updateRule(index, {
                    provider: value,
                    model,
                    reasoningEffort: reconcileEffort(routes, value, model, rule.reasoningEffort),
                  });
                },
              }),
            ),
            h(
              'div',
              { className: 'cm-field', style: { flex: '1 1 180px' } },
              h('span', { className: 'cm-fieldLabel' }, '模型'),
              h(ModelSelect, {
                className: 'cm-model',
                value: rule.model,
                groups: modelOptions(rule.provider),
                placeholder: '选择模型',
                emptyHint:
                  rule.provider === '' ? '先选渠道' : '这个渠道下没有可用模型',
                ariaLabel: '规则 model',
                testId: 'model-select',
                onChange: (value) =>
                  updateRule(index, {
                    model: value,
                    reasoningEffort: reconcileEffort(routes, rule.provider, value, rule.reasoningEffort),
                  }),
              }),
            ),
            h(
              'div',
              { className: 'cm-field', style: { flex: '0 1 180px' } },
              h('span', { className: 'cm-fieldLabel' }, '推理档位'),
              h(ModelSelect, {
                className: 'cm-effort',
                /* 值用哨兵折算：ModelSelect 会丢掉空串值的选项，而「自动」落盘必须是空串。 */
                value: effortSelectValue(rule.reasoningEffort),
                options: effortChoices(effortList, ruleModel === null ? '' : ruleModel.defaultEffort),
                placeholder: '自动（由适配器挑）',
                emptyHint: effortDisabled ? '该模型不声明档位' : '没有可选项',
                ariaLabel: '规则推理档位',
                testId: 'effort-select',
                disabled: effortDisabled,
                onChange: (value) => updateRule(index, { reasoningEffort: effortFromSelect(value) }),
              }),
              /* 禁用的触发器点不开弹层，提示必须留在外面，否则用户只看到灰按钮不知道为什么。 */
              effortDisabled
                ? h(
                    'span',
                    { className: 'cm-fieldHint' },
                    rule.provider === '' || rule.model === ''
                      ? '先选渠道和模型'
                      : '该模型不声明档位',
                  )
                : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cm-iconBtn',
                'aria-label': '删除这条规则',
                title: '删除这条规则',
                onClick: () => removeRule(index),
              },
              trashIcon(),
            ),
          ),
          h(
            'p',
            { className: 'cm-ruleMeta' },
            metaText,
            matched.length === 0
              ? null
              : matched.map((name, at) =>
                  h(
                    'span',
                    { className: 'cm-ruleMetaHit', key: 'hit:' + name },
                    (at === 0 ? '' : '、') + name,
                  ),
                ),
          ),
        );
      });

      const routeRows = (Array.isArray(recent) ? recent : []).map((event, index) => {
        const applied = isObject(event) && isObject(event.applied) ? event.applied : null;
        const route = routeLabel(applied);
        const effort = effortLabel(applied);
        const label = isObject(event) ? textOf(event.label) : '';
        return h(
          'tr',
          { key: 'event:' + String(index) },
          h('td', { className: 'cm-mono' }, isObject(event) ? clockOf(event.time) : '—'),
          h(
            'td',
            null,
            targetLabel(event),
            label !== '' && label !== targetLabel(event)
              ? h('div', { className: 'cm-sub' }, label)
              : null,
          ),
          h(
            'td',
            { className: 'cm-mono' },
            route === '' ? '—' : route,
            effort === '' ? null : h('div', { className: 'cm-sub' }, effort),
          ),
          h('td', { className: 'cm-mono' }, hitLabel(applied)),
        );
      });

      let recentBlock = null;
      if (recent === undefined) {
        recentBlock = h(
          'div',
          { className: 'cm-section' },
          h('div', { className: 'cm-sectionTitle' }, '最近委派'),
          h('div', { className: 'cm-hint' }, '加载中…'),
        );
      } else if (Array.isArray(recent)) {
        recentBlock = h(
          'div',
          { className: 'cm-section' },
          h('div', { className: 'cm-sectionTitle' }, '最近委派'),
          recent.length === 0
            ? h('div', { className: 'cm-empty' }, '还没有记录，创建一个子智能体试试')
            : h(
                'table',
                { className: 'cm-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['时间', '对象', '实际使用的模型', '为什么是这个模型'].map((label) =>
                      h('th', { key: 'th:' + label }, label),
                    ),
                  ),
                ),
                h('tbody', null, routeRows),
              ),
        );
      }

      return h(
        'div',
        { className: 'cm-card' },
        styleTag(),

        h(
          'div',
          { className: 'cm-head' },
          h(
            'div',
            { className: 'cm-headText' },
            h('h3', { className: 'cm-title' }, '子智能体模型'),
            h(
              'div',
              { className: 'cm-hint' },
              '队友和子智能体默认跟随主 Agent 的模型；下面可以按名字或任务描述单独指定。',
            ),
            h('div', { className: 'cm-summary' }, summaryText()),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cm-switchTrack',
              role: 'switch',
              'aria-checked': draft.enabled,
              'aria-label': '启用子智能体模型路由',
              onClick: () => patchDraft({ enabled: !draft.enabled }),
            },
            h('span', { className: 'cm-switchKnob' }),
          ),
        ),

        h(
          'div',
          { className: 'cm-section' },
          h('div', { className: 'cm-sectionTitle' }, '没匹配到规则时'),
          h(
            'div',
            { className: 'cm-hint' },
            '队友和子智能体默认跟随主 Agent 的模型。想让没匹配上的那些用别的模型，就在这里选。',
          ),
          routes.length === 0
            ? h(
                'div',
                { className: 'cm-warn' },
                '没有可用的模型路由（LLM 服务未就绪）；已保存的值仍会原样显示。',
              )
            : null,
          h(
            'div',
            { className: 'cm-field' },
            h('span', { className: 'cm-fieldLabel' }, '默认模型'),
            h(ModelSelect, {
              className: 'cm-defaultSel',
              value: draft.useDefault ? draft.defaultRoute.provider + '|' + draft.defaultRoute.model : '',
              options: inheritFirstOptions(),
              placeholder: '继承主 Agent（默认）',
              emptyHint: '没有可用的渠道（LLM 服务未就绪）',
              ariaLabel: '默认路由',
              testId: 'default-route-select',
              onChange: (value) => chooseDefault(value),
            }),
          ),
          draft.useDefault
            ? h(
                'div',
                { className: 'cm-hint' },
                '档位留空 = 由宿主自动挑一个该模型支持的档位。',
              )
            : null,
        ),

        h(
          'div',
          { className: 'cm-section' },
          h('div', { className: 'cm-sectionTitle' }, '按名字或任务描述指定'),
          h(
            'div',
            { className: 'cm-hint' },
            '队友名或任务描述里出现这个词，就用这条模型；名字比描述优先，不区分大小写。',
          ),
          draft.rules.length === 0
            ? h(
                'div',
                { className: 'cm-empty' },
                '还没有规则，所有成员都按上面那个默认模型走。',
              )
            : h('div', { className: 'cm-rules' }, ruleRows),
          h(
            'div',
            { className: 'cm-row' },
            h(
              'button',
              { type: 'button', className: 'cm-btn', onClick: addRule },
              '＋ 添加规则',
            ),
          ),
        ),

        h(
          'div',
          { className: 'cm-section' },
          h('div', { className: 'cm-sectionTitle' }, '生效范围'),
          h(
            'div',
            { className: 'cm-field' },
            h('span', { className: 'cm-fieldLabel' }, '委派深度'),
            h(
              'div',
              { className: 'cm-row' },
              h('input', {
                type: 'number',
                className: 'cm-input cm-depth',
                min: 0,
                max: 9,
                step: 1,
                value: draft.maxDepth,
                'aria-label': '最大委派深度',
                onChange: (event) => patchDraft({ maxDepth: event.target.value }),
              }),
              h('span', { className: 'cm-hint' }, '默认 1，只影响直接子代'),
            ),
          ),
          h(
            'label',
            { className: 'cm-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.applyToFork,
              onChange: (event) => patchDraft({ applyToFork: event.target.checked }),
            }),
            h('span', null, '也让 fork 出来的子智能体换模型'),
          ),
          h(
            'div',
            { className: 'cm-hint' },
            'fork 会继承父级前缀缓存，换模型会降低缓存命中率，通常不用开。',
          ),
        ),

        h(
          'div',
          { className: 'cm-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'cm-btn cm-btnPrimary',
              disabled: saving,
              onClick: () => {
                void save();
              },
            },
            saving ? '保存中…' : '保存',
          ),
          feedback === null
            ? null
            : h(
                'span',
                { className: feedback.kind === 'ok' ? 'cm-ok' : 'cm-err', role: 'status' },
                feedback.text,
              ),
        ),

        recentBlock,
      );
    }

    function Panel() {
      return h(ErrorBoundary, null, h(Body, null));
    }

    /* ── 对话头部：点成员换模型 ───────────────────────────────────────────── */

    /**
     * 头部入口。标准 kit 里 `useSession` 能读到「当前会话是哪个队员的」，
     * 有它就优先拿它来定位真正要操作的 Lead 会话；没有就退回 `sessionId`。
     *
     * `useSession` 缺席时不能调用它（hook 顺序必须稳定），所以拆成两个组件：
     * 缺席走 PickerBody(sessionId)，在场走 PickerWithSession。
     */
    function PickerAction(props) {
      const seats = isObject(props) ? props : {};
      return h(
        ErrorBoundary,
        null,
        typeof seats.useSession === 'function'
          ? h(PickerWithSession, seats)
          : h(PickerBody, { lead: textOf(seats.sessionId) }),
      );
    }

    function PickerWithSession(props) {
      const parent = props.useSession((snapshot) =>
        isObject(snapshot) && isObject(snapshot.subagent) && isObject(snapshot.subagent.address)
          ? snapshot.subagent.address.parentSessionId
          : undefined,
      );
      const lead = textOf(parent) !== '' ? textOf(parent) : textOf(props.sessionId);
      return h(PickerBody, { lead });
    }

    function PickerBody(props) {
      const lead = textOf(isObject(props) ? props.lead : '');
      const [open, setOpen] = React.useState(false);
      const [phase, setPhase] = React.useState('idle'); // idle | loading | ready | error
      const [loadError, setLoadError] = React.useState('');
      const [members, setMembers] = React.useState([]);
      const [routes, setRoutes] = React.useState([]);
      /* 点名表：存的是 `settings.members` 的**全部键**（含已结束成员），不是成员列表。
         成员列表里看不见的残留只能从这里清，否则永远删不掉。 */
      const [fixedRows, setFixedRows] = React.useState([]);
      const [pinsOpen, setPinsOpen] = React.useState(false);
      const [pinsBusy, setPinsBusy] = React.useState('');
      const [pinsConfirm, setPinsConfirm] = React.useState(false);
      /* 最近换路由失败（宿主在 `/state`、`/members`、`/rules` 下发）。只读展示，不回写。 */
      const [lastErrors, setLastErrors] = React.useState([]);
      const [errorsOpen, setErrorsOpen] = React.useState(false);
      /* 关掉红条时记住当时最新一条的时间：只有**更新的**失败才把它顶回来。 */
      const [errorsHiddenAt, setErrorsHiddenAt] = React.useState(0);
      // 「本对话默认」：首次创建时回答的那条；null = 没设（继承主 Agent）。
      const [sessionDefault, setSessionDefault] = React.useState(null);
      const [expanded, setExpanded] = React.useState('');
      const [draft, setDraft] = React.useState({ provider: '', model: '', effort: '' });
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      const [anchor, setAnchor] = React.useState(null);
      const [reloadTick, setReloadTick] = React.useState(0);
      /* 新建表单：面板默认收起，避免挡住成员列表；新建失败/成功后仍留在原地。 */
      const [createOpen, setCreateOpen] = React.useState(false);
      const [kind, setKind] = React.useState('teammate');
      const [form, setForm] = React.useState({
        name: '',
        description: '',
        prompt: '',
        provider: '',
        model: '',
        effort: '',
      });
      const [formError, setFormError] = React.useState('');
      const [creating, setCreating] = React.useState(false);
      /* 批量条：常驻一行，不经折叠；`bulk` 是选择，「全部恢复继承」复用 route: null。 */
      const [bulk, setBulk] = React.useState({ provider: '', model: '', effort: '' });
      const [bulkBusy, setBulkBusy] = React.useState(false);
      const [bulkError, setBulkError] = React.useState('');
      const [bulkResult, setBulkResult] = React.useState(null);
      /* 批量二次确认：`{ route, text }`；route 为 null 表示「全部恢复继承」；null = 没有待确认的操作。 */
      const [bulkConfirm, setBulkConfirm] = React.useState(null);
      /* 批量撤销：应用成功后 5 秒内有效，携带应用**前**逐个成员的路由快照。 */
      const [bulkUndo, setBulkUndo] = React.useState(null);
      const [, setUndoTick] = React.useState(0);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);

      /* 成员行的「恢复继承」按钮只看点名表里真的有键的名字；派生而不是再存一份，
         免得两处状态各走各的。 */
      const fixedNames = fixedRows.filter((row) => row.valid).map((row) => row.key);

      // 数据面：只在打开面板时取，避免每个会话一进来就多发一个请求。
      React.useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        // 刷新（新建成功后的补拉）不清空已有内容：先显示旧列表，回来了再换。
        setPhase((current) => (current === 'ready' ? current : 'loading'));
        setLoadError('');
        (async () => {
          const response = await request(MEMBERS_PATH + '?lead=' + encodeURIComponent(lead));
          if (!alive) return;
          const payload = response.data;
          if (response.ok && isObject(payload) && payload.ok === true) {
            const routeList = readRoutes(payload.routes);
            setMembers(readMemberList(payload.members));
            setRoutes(routeList);
            setFixedRows(
              readFixedEntries(isObject(payload.settings) ? payload.settings.members : undefined),
            );
            setLastErrors(readErrors(payload.lastErrors));
            // 「本对话默认」：首次创建时回答的那个选择，这里回读以便显示/清除。
            const sessionRoute = isObject(payload.settings) ? payload.settings.sessionRoute : undefined;
            const route = isObject(sessionRoute) ? sessionRoute : null;
            setSessionDefault(
              route === null
                ? null
                : {
                    provider: textOf(route.provider),
                    model: textOf(route.model),
                    reasoningEffort: textOf(route.reasoningEffort),
                  },
            );
            // 表单的 provider/model 留空时补一个可用的，省掉用户第一次点两次下拉。
            setForm((current) => {
              if (current.provider !== '') return current;
              const fallback = firstUsableRoute(routeList);
              if (fallback === null) return current;
              return { ...current, provider: fallback.provider, model: fallback.model };
            });
            setBulk((current) => {
              if (current.provider !== '') return current;
              const fallback = firstUsableRoute(routeList);
              if (fallback === null) return current;
              return { ...current, provider: fallback.provider, model: fallback.model };
            });
            setPhase('ready');
            return;
          }
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setLoadError(
            detail === ''
              ? '无法读取成员列表（HTTP ' + String(response.status) + '）'
              : detail,
          );
          setPhase('error');
        })();
        return () => {
          alive = false;
        };
      }, [open, lead, reloadTick]);

      // 外部点击 / Escape 关闭；视口变化时重新贴住触发按钮（面板不溢出）。
      React.useEffect(() => {
        if (!open) return undefined;
        const measure = () => {
          const trigger = triggerRef.current;
          if (
            trigger === null ||
            trigger === undefined ||
            typeof trigger.getBoundingClientRect !== 'function'
          ) {
            return;
          }
          if (
            typeof window === 'undefined' ||
            !Number.isFinite(window.innerWidth) ||
            !Number.isFinite(window.innerHeight)
          ) {
            return;
          }
          const rect = trigger.getBoundingClientRect();
          const width = Math.min(360, Math.max(260, window.innerWidth - 24));
          const left = Math.max(
            12,
            Math.min(rect.right - width, window.innerWidth - width - 12),
          );
          const below = window.innerHeight - rect.bottom - 12;
          const above = rect.top - 12;
          const up = below < 220 && above > below;
          const maxHeight = Math.max(160, Math.min(360, up ? above : below));
          const top = up ? Math.max(12, rect.top - 6 - maxHeight) : rect.bottom + 6;
          setAnchor({ top, left, width, maxHeight });
        };
        measure();

        const onKeyDown = (event) => {
          if (isObject(event) && event.key === 'Escape') setOpen(false);
        };
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root !== null && typeof root.contains === 'function' && root.contains(event.target)) {
            return;
          }
          setOpen(false);
        };

        let detachWindow = () => {};
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure);
          window.addEventListener('scroll', measure, true);
          detachWindow = () => {
            window.removeEventListener('resize', measure);
            window.removeEventListener('scroll', measure, true);
          };
        }
        return () => {
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
          }
          detachWindow();
        };
      }, [open]);

      // 换会话就收起，避免面板跨会话残留。
      React.useEffect(() => {
        setOpen(false);
        setExpanded('');
        setNotice(null);
      }, [lead]);

      // 短暂提示：2.6 秒后自动消失，卸载/替换时清定时器。
      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 2600);
        return () => clearTimeout(timer);
      }, [notice]);

      /* 撤销窗口：到点就撤掉按钮；窗口内每 250ms 抖一下 state，好让「（4s）」倒计时动。
         不用 CSS 动画算时间——按钮得真的消失，不能只是看起来淡了。 */
      React.useEffect(() => {
        if (bulkUndo === null) return undefined;
        const left = bulkUndo.expiresAt - Date.now();
        const expiry = setTimeout(() => setBulkUndo(null), Math.max(0, left));
        const ticker = setInterval(() => setUndoTick((tick) => tick + 1), 250);
        return () => {
          clearTimeout(expiry);
          clearInterval(ticker);
        };
      }, [bulkUndo]);

      /** 撤销剩余秒数（向上取整，最低 0）；没有撤销窗口时给 0。 */
      function undoSecondsLeft() {
        if (bulkUndo === null) return 0;
        return Math.max(0, Math.ceil((bulkUndo.expiresAt - Date.now()) / 1000));
      }

      function toggleRow(member) {
        const key = memberKey(member);
        if (expanded === key) {
          setExpanded('');
          return;
        }
        setExpanded(key);
        setNotice(null);
        // 草稿取「当前显示的路由」：pending 的成员显示的正是点名表里的设定值，
        // 这里必须沿用它，不能因为没在运行就退回空选择（那会让用户以为设定丢了）。
        setDraft({
          provider: member.provider,
          model: member.model,
          effort: member.reasoningEffort,
        });
      }

      function patchDraft(patch) {
        setDraft((current) => ({ ...current, ...patch }));
      }

      function applyPayload(payload, target, route) {
        if (isObject(payload) && isObject(payload.settings)) {
          setFixedRows(readFixedEntries(payload.settings.members));
        }
        /* 失败榜跟着每次回包刷新：换模型失败的那一下，红条要立刻出现，
           不能等用户关掉再打开面板。响应没带这个字段时保持原样（老宿主）。 */
        if (isObject(payload) && Array.isArray(payload.lastErrors)) {
          setLastErrors(readErrors(payload.lastErrors));
        }
        if (isObject(payload) && Array.isArray(payload.members)) {
          setMembers(readMemberList(payload.members));
          return;
        }
        // 响应没带成员表时至少把这一行改掉，界面不能停在旧值上。
        setMembers((current) =>
          current.map((item) =>
            memberKey(item) === memberKey(target)
              ? {
                  ...item,
                  provider: route === null ? '' : route.provider,
                  model: route === null ? '' : route.model,
                  reasoningEffort: route === null ? '' : textOf(route.reasoningEffort),
                }
              : item,
          ),
        );
      }

      async function submit(member) {
        if (busy !== '') return;
        const provider = draft.provider;
        const model = draft.model;
        if (provider === '' || model === '') return;
        const key = memberKey(member);
        const effort = draft.effort.trim();
        const route = {
          provider,
          model,
          ...(effort === '' ? {} : { reasoningEffort: effort }),
        };
        setBusy(key);
        const body = {
          ...(member.isMember && member.name !== ''
            ? { name: member.name }
            : { childId: member.childId }),
          route,
          lead,
        };
        const response = await request(MEMBER_SET_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy('');
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setNotice({
            kind: 'error',
            text: detail === '' ? '应用失败（HTTP ' + String(response.status) + '）' : detail,
          });
          return;
        }
        applyPayload(payload, member, route);
        const applied = Array.isArray(payload.applied) ? payload.applied : [];
        setExpanded('');
        setNotice({
          kind: 'ok',
          text: applied.length === 0 ? '已保存，下次唤醒该成员时生效（不需要重启）' : '已生效',
        });
      }

      /* ── 本对话默认：一次选好，这个对话里派活都按它，不再询问 ─────────── */

      /** 合并成「渠道 + 模型」的下拉项，第一项是「继承主 Agent」（值空串）。 */
      function sessionOptions() {
        const options = [
          { value: '', label: '继承主 Agent', hint: '不干预，用我当前的模型' },
        ];
        for (const route of routes) {
          for (const model of modelsOf(routes, route.id)) {
            options.push({
              value: route.id + '|' + model.id,
              label: model.name || model.id,
              hint: route.name === route.id ? route.id : route.name,
            });
          }
        }
        return options;
      }

      function sessionValue() {
        if (sessionDefault === null) return '';
        if (sessionDefault.provider === '' || sessionDefault.model === '') return '';
        return sessionDefault.provider + '|' + sessionDefault.model;
      }

      /**
       * 写「本对话默认」。选「继承」= 提交 `route: null`，宿主会连「已问过」标记
       * 一起清掉 —— 于是下次派活又会问一遍（这是重置语义）。
       */
      async function chooseSessionDefault(value) {
        if (busy !== '') return;
        let body = { lead, route: null };
        if (value !== '') {
          const at = value.indexOf('|');
          if (at <= 0) return;
          const provider = value.slice(0, at);
          const model = value.slice(at + 1);
          if (provider === '' || model === '') return;
          body = { lead, route: { provider, model } };
        }
        setBusy('session');
        const response = await request(SESSION_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setBusy('');
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setNotice({
            kind: 'error',
            text: detail === '' ? '保存失败（HTTP ' + String(response.status) + '）' : detail,
          });
          return;
        }
        const route = isObject(payload.sessionRoute) ? payload.sessionRoute : null;
        setSessionDefault(
          route === null
            ? null
            : {
                provider: textOf(route.provider),
                model: textOf(route.model),
                reasoningEffort: textOf(route.reasoningEffort),
              },
        );
        setNotice({
          kind: 'ok',
          text:
            route === null
              ? '已改为继承主 Agent，取消了这个对话的默认'
              : '本对话默认已设定，之后派活不再询问',
        });
      }

      async function clearRoute(member) {
        if (busy !== '') return;
        if (!(member.isMember && member.name !== '')) return;
        const key = memberKey(member);
        setBusy(key);
        const response = await request(MEMBER_SET_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: member.name, route: null, lead }),
        });
        setBusy('');
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setNotice({
            kind: 'error',
            text: detail === '' ? '恢复失败（HTTP ' + String(response.status) + '）' : detail,
          });
          return;
        }
        applyPayload(payload, member, null);
        const applied = Array.isArray(payload.applied) ? payload.applied : [];
        setExpanded('');
        setNotice({
          kind: 'ok',
          text: applied.length === 0 ? '已恢复继承，下次唤醒该成员时生效（不需要重启）' : '已恢复继承',
        });
        pushToast('ok', member.name + ' 已恢复继承');
      }

      /* ── 点名表管理：清掉已经结束的成员留下的残留 ─────────────────────── */

      /**
       * 清掉点名表里的某一个键。
       *
       * 键原样当 `name` 发给 `/member`（宿主对 `name` 不做形状校验、直接当键用），
       * 于是队友名、`#<childId>`、以及任何历史残留都能用同一条路径删掉。
       * 不用新增端点，也不区分这个成员现在还在不在。
       */
      async function clearPinned(key) {
        if (pinsBusy !== '' || busy !== '' || key === '') return;
        setPinsBusy(key);
        const response = await request(MEMBER_SET_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: key, route: null, lead }),
        });
        setPinsBusy('');
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          const detail = isObject(payload) ? textOf(payload.error) : '';
          const text = detail === '' ? '恢复失败（HTTP ' + String(response.status) + '）' : detail;
          setNotice({ kind: 'error', text });
          pushToast('error', '点名表清理失败（' + key + '）：' + text);
          return;
        }
        if (isObject(payload.settings) && isObject(payload.settings.members)) {
          setFixedRows(readFixedEntries(payload.settings.members));
        } else {
          // 响应没带点名表时至少把这一行抹掉，界面不能停在旧值上。
          setFixedRows((current) => current.filter((row) => row.key !== key));
        }
        if (Array.isArray(payload.members)) setMembers(readMemberList(payload.members));
        setNotice({ kind: 'ok', text: '已恢复继承：' + key });
        pushToast('ok', '已恢复继承：' + key);
      }

      /** 清空整张点名表：逐条 `route: null`，串行发（宿主每次都要落盘）。 */
      async function clearAllPinned() {
        if (pinsBusy !== '' || busy !== '') return;
        const keys = fixedRows.map((row) => row.key);
        setPinsConfirm(false);
        if (keys.length === 0) return;
        setPinsBusy('*');
        setNotice(null);
        let removed = 0;
        let failedCount = 0;
        let lastMembers = null;
        let lastSettings = null;
        for (const key of keys) {
          const response = await request(MEMBER_SET_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: key, route: null, lead }),
          });
          const payload = response.data;
          if (!(response.ok && isObject(payload) && payload.ok === true)) {
            failedCount += 1;
            continue;
          }
          removed += 1;
          if (Array.isArray(payload.members)) lastMembers = payload.members;
          if (isObject(payload.settings) && isObject(payload.settings.members)) {
            lastSettings = payload.settings.members;
          }
        }
        setPinsBusy('');
        if (lastSettings !== null) setFixedRows(readFixedEntries(lastSettings));
        if (lastMembers !== null) {
          setMembers(readMemberList(lastMembers));
          setPhase('ready');
        } else {
          setReloadTick((tick) => tick + 1);
        }
        setNotice({
          kind: failedCount === 0 ? 'ok' : 'error',
          text:
            failedCount === 0
              ? '已清空 ' + String(removed) + ' 条点名'
              : '清掉 ' + String(removed) + ' 条，' + String(failedCount) + ' 条失败',
        });
      }

      /* ── 新建队友 / 子智能体 ─────────────────────────────────────────── */

      function patchForm(patch) {
        setForm((current) => ({ ...current, ...patch }));
      }

      /** 名字只在 teammate 时校验；子智能体不需要名字。 */
      function nameInvalid() {
        if (kind !== 'teammate') return false;
        return !TEAMMATE_NAME_RE.test(form.name.trim());
      }

      function createDisabled() {
        if (creating) return true;
        if (form.description.trim() === '') return true;
        if (form.prompt.trim() === '') return true;
        if (form.provider === '' || form.model === '') return true;
        return nameInvalid();
      }

      async function create() {
        if (creating || createDisabled()) return;
        const name = form.name.trim();
        const description = form.description.trim();
        const prompt = form.prompt.trim();
        const effort = form.effort.trim();
        const route = {
          provider: form.provider,
          model: form.model,
          ...(effort === '' ? {} : { reasoningEffort: effort }),
        };
        setCreating(true);
        setFormError('');
        const response = await request(SPAWN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            lead,
            kind,
            ...(kind === 'teammate' ? { name } : {}),
            description,
            prompt,
            route,
          }),
        });
        setCreating(false);
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          // 失败不清空输入：用户要能改一个字再试。error 文本原样显示。
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setFormError(detail === '' ? '创建失败（HTTP ' + String(response.status) + '）' : detail);
          return;
        }
        // 成功：清掉文本字段，保留 provider/model，方便连建第二个。
        setForm((current) => ({ ...current, name: '', description: '', prompt: '', effort: '' }));
        setFormError('');
        setNotice({ kind: 'ok', text: '已创建' });
        if (isObject(payload) && Array.isArray(payload.members)) {
          setMembers(readMemberList(payload.members));
          setPhase('ready');
          return;
        }
        // 响应没带成员表（或面板此前是空态）时重新拉一次，保证新成员出现在列表里。
        setReloadTick((tick) => tick + 1);
      }

      /* ── 批量：把本会话全部成员换成同一个模型 ───────────────────────── */

      function patchBulk(patch) {
        setBulk((current) => ({ ...current, ...patch }));
        setBulkResult(null);
        setBulkError('');
        // 改了选择就把待确认的那条撤掉：确认条上的目标必须和当前选择一致。
        setBulkConfirm(null);
      }

      /**
       * 把 `{applied, saved, failed}` 拆成按段渲染的结果：只有「改写失败」用 warn 色，
       * 其余保持说明文字的层级——整行变色会让人以为全失败了。
       *
       * 另外补一条 note：一个都没立刻切换、却写进了点名表时，最容易让人误以为
       * 「没生效」，所以明说它们只是还没被唤醒。
       */
      function summarizeBulk(payload) {
        const applied = Number.isSafeInteger(payload.applied) ? payload.applied : 0;
        const saved = Number.isSafeInteger(payload.saved) ? payload.saved : 0;
        const failed = Number.isSafeInteger(payload.failed) ? payload.failed : 0;
        if (applied === 0 && saved === 0 && failed === 0) {
          return { parts: [{ text: '没有可应用的对象', warn: false }], note: '' };
        }
        const parts = [];
        if (applied > 0) {
          parts.push({ text: '已立即切换 ' + String(applied) + ' 个正在运行的成员', warn: false });
        }
        if (saved > 0) {
          parts.push({ text: '另有 ' + String(saved) + ' 个已记录，唤醒时生效', warn: false });
        }
        if (failed > 0) parts.push({ text: String(failed) + ' 个改写失败', warn: true });
        return {
          parts,
          note:
            applied === 0 && saved > 0 ? '这些成员当前都没在运行，唤醒后就会用新模型' : '',
        };
      }

      /**
       * 应用前的逐成员路由快照。撤销就是把它逐条按 `/member` 写回去：
       * 有名字的用 `name`，没名字的子智能体用 `childId`（宿主会折算成 `#<id>`）。
       * 本来就在继承（provider/model 皆空）的成员记成 `route: null`，撤销时正好删除点名。
       */
      function routeSnapshot() {
        const items = [];
        for (const member of members) {
          if (member.name === '' && member.childId === '') continue;
          const effort = textOf(member.reasoningEffort);
          items.push({
            ...(member.name !== '' ? { name: member.name } : { childId: member.childId }),
            route:
              member.provider === '' || member.model === ''
                ? null
                : {
                    provider: member.provider,
                    model: member.model,
                    ...(effort === '' ? {} : { reasoningEffort: effort }),
                  },
          });
        }
        return items;
      }

      async function submitBulk(route) {
        if (bulkBusy) return;
        // 快照必须在请求**之前**取：响应一回来 members 就已经是新路由了。
        const snapshot = routeSnapshot();
        setBulkConfirm(null);
        setBulkUndo(null);
        setBulkBusy(true);
        setBulkError('');
        setBulkResult(null);
        const response = await request(BULK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lead, route, scope: 'all' }),
        });
        setBulkBusy(false);
        const payload = response.data;
        if (!(response.ok && isObject(payload) && payload.ok === true)) {
          // 失败不动用户的选择：只把 error 原样放出来。
          const detail = isObject(payload) ? textOf(payload.error) : '';
          setBulkError(detail === '' ? '批量应用失败（HTTP ' + String(response.status) + '）' : detail);
          return;
        }
        if (route === null) {
          setBulkResult({ parts: [{ text: '已全部恢复继承', warn: false }], note: '' });
        } else {
          setBulkResult(summarizeBulk(payload));
        }
        // 5 秒撤销窗口：只有成功才给，失败时「撤销」没有意义。
        if (snapshot.length > 0) {
          setBulkUndo({ items: snapshot, expiresAt: Date.now() + BULK_UNDO_MS });
        }
        if (isObject(payload) && Array.isArray(payload.members)) {
          setMembers(readMemberList(payload.members));
          setPhase('ready');
          setExpanded('');
          return;
        }
        setReloadTick((tick) => tick + 1);
      }

      /** 点「应用到全部 / 全部恢复继承」先出确认条，不在按钮里直接发请求。 */
      function askBulk(route) {
        if (bulkBusy) return;
        if (members.length === 0) return;
        setBulkError('');
        setBulkResult(null);
        setBulkUndo(null);
        const count = '将影响 ' + String(members.length) + ' 个成员：';
        const effort = route === null ? '' : textOf(route.reasoningEffort);
        setBulkConfirm({
          route,
          text:
            route === null
              ? count + '全部恢复为继承主 Agent'
              : count +
                '全部换成 ' +
                route.provider +
                '/' +
                route.model +
                (effort === '' ? '（档位自动）' : ' · 档位 ' + effort),
        });
      }

      async function confirmBulk() {
        if (bulkConfirm === null || bulkBusy) return;
        await submitBulk(bulkConfirm.route);
      }

      /**
       * 撤销上一批：逐条把快照写回 `/member`。
       *
       * 没有批量撤销端点（也不许加），所以只能一条一条来；这里串行发送是有意的——
       * 宿主每次都要落盘 rules.json，并发写会互相覆盖，慢一点但结果确定。
       */
      async function undoBulk() {
        if (bulkUndo === null || bulkBusy) return;
        const items = bulkUndo.items;
        setBulkUndo(null);
        setBulkBusy(true);
        setBulkError('');
        setBulkResult(null);
        let restored = 0;
        let failedCount = 0;
        let lastMembers = null;
        let lastSettings = null;
        for (const item of items) {
          const response = await request(MEMBER_SET_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...item, lead }),
          });
          const payload = response.data;
          if (!(response.ok && isObject(payload) && payload.ok === true)) {
            failedCount += 1;
            continue;
          }
          restored += 1;
          if (Array.isArray(payload.members)) lastMembers = payload.members;
          if (isObject(payload.settings) && isObject(payload.settings.members)) {
            lastSettings = payload.settings.members;
          }
        }
        setBulkBusy(false);
        if (lastSettings !== null) setFixedRows(readFixedEntries(lastSettings));
        if (lastMembers !== null) {
          setMembers(readMemberList(lastMembers));
          setPhase('ready');
        } else {
          setReloadTick((tick) => tick + 1);
        }
        setBulkResult({
          parts: [
            { text: '已撤销 ' + String(restored) + ' 个成员的路由', warn: false },
            ...(failedCount === 0
              ? []
              : [{ text: String(failedCount) + ' 个撤销失败', warn: true }]),
          ],
          note: '',
        });
      }

      function bulkRoute() {
        const provider = bulk.provider;
        const model = bulk.model;
        if (provider === '' || model === '') return null;
        const effort = bulk.effort.trim();
        return {
          provider,
          model,
          ...(effort === '' ? {} : { reasoningEffort: effort }),
        };
      }

      function renderBulkBar() {
        const route = bulkRoute();
        const canApply = route !== null && !bulkBusy && members.length > 0;
        return h(
          'div',
          { className: 'cmp-bulk' },
          h(
            'div',
            { className: 'cmp-bulkRow' },
            h('span', { className: 'cmp-bulkLabel' }, '全部换成'),
            h(ModelSelect, {
              className: 'cmp-provider',
              value: bulk.provider,
              options: providerChoiceList(routes),
              placeholder: '渠道',
              emptyHint: '没有可用的渠道（LLM 服务未就绪）',
              ariaLabel: '批量的 provider',
              testId: 'provider-select',
              disabled: bulkBusy,
              onChange: (value) => {
                const models = modelsOf(routes, value);
                patchBulk({
                  provider: value,
                  model: models.length > 0 ? models[0].id : '',
                  effort: '',
                });
              },
            }),
            h(ModelSelect, {
              className: 'cmp-modelSel',
              value: bulk.model,
              groups: modelChoiceGroups(routes, bulk.provider),
              placeholder: '模型',
              emptyHint: bulk.provider === '' ? '先选渠道' : '这个渠道下没有可用模型',
              ariaLabel: '批量的 model',
              testId: 'model-select',
              disabled: bulkBusy,
              onChange: (value) => patchBulk({ model: value, effort: '' }),
            }),
            h('input', {
              type: 'text',
              className: 'cmp-input cmp-effort',
              value: bulk.effort,
              placeholder: '档位（可选）',
              'aria-label': '批量的推理档位',
              disabled: bulkBusy,
              onChange: (event) => patchBulk({ effort: event.target.value }),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn cmp-btnPrimary',
                disabled: !canApply,
                onClick: () => {
                  const picked = bulkRoute();
                  if (picked === null) return;
                  askBulk(picked);
                },
              },
              bulkBusy ? '应用中…' : '应用到全部',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn',
                disabled: bulkBusy || members.length === 0,
                onClick: () => {
                  askBulk(null);
                },
              },
              '全部恢复继承',
            ),
            members.length === 0
              ? h('span', { className: 'cmp-guide' }, '还没有队友或子智能体')
              : null,
          ),
          // 二次确认：把「影响多少人、换成什么」摊开，再让用户点第二次。
          bulkConfirm === null
            ? null
            : h(
                'div',
                { className: 'cmp-bulkRow' },
                h('span', { className: 'cmp-bulkResult cmp-bulkWarn' }, bulkConfirm.text),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-btn cmp-btnPrimary',
                    disabled: bulkBusy,
                    onClick: () => {
                      void confirmBulk();
                    },
                  },
                  '确认应用',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-btn',
                    disabled: bulkBusy,
                    onClick: () => setBulkConfirm(null),
                  },
                  '取消',
                ),
              ),
          // 撤销：成功后的 5 秒窗口内可见，带倒计时，到点自己消失。
          bulkUndo === null
            ? null
            : h(
                'div',
                { className: 'cmp-bulkRow' },
                h(
                  'span',
                  { className: 'cmp-bulkNote' },
                  '刚才那批可在 ' + String(undoSecondsLeft()) + ' 秒内撤销',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-btn',
                    disabled: bulkBusy,
                    onClick: () => {
                      void undoBulk();
                    },
                  },
                  '撤销',
                ),
              ),
          bulkError === ''
            ? null
            : h('p', { className: 'cmp-bulkResult cmp-bulkErr', role: 'status' }, bulkError),
          bulkResult === null
            ? null
            : h(
                'p',
                { className: 'cmp-bulkResult', role: 'status' },
                bulkResult.parts.map((part, index) =>
                  h(
                    'span',
                    { key: 'bulkpart:' + String(index), className: part.warn ? 'cmp-bulkWarn' : undefined },
                    (index === 0 ? '' : '；') + part.text,
                  ),
                ),
              ),
          bulkResult === null || bulkResult.note === ''
            ? null
            : h('p', { className: 'cmp-bulkNote', role: 'status' }, bulkResult.note),
        );
      }

      function renderCreateForm() {
        const invalid = nameInvalid();
        const disabled = createDisabled();
        const fields = [];

        if (kind === 'teammate') {
          fields.push(
            h(
              'div',
              { className: 'cmp-field', key: 'name' },
              h('label', { className: 'cmp-label' }, '名称'),
              h('input', {
                type: 'text',
                className: 'cmp-input cmp-inputWide',
                value: form.name,
                placeholder: 'reviewer-2',
                'aria-label': '队友名称',
                'aria-invalid': invalid,
                disabled: creating,
                onChange: (event) => patchForm({ name: event.target.value }),
              }),
              invalid && form.name.trim() !== ''
                ? h(
                    'span',
                    { className: 'cmp-fieldErr' },
                    '只能用小写字母、数字和连字符，且以字母或数字开头',
                  )
                : null,
            ),
          );
        }

        fields.push(
          h(
            'div',
            { className: 'cmp-field', key: 'description' },
            h('label', { className: 'cmp-label' }, '任务描述'),
            h('input', {
              type: 'text',
              className: 'cmp-input cmp-inputWide',
              value: form.description,
              placeholder: '例如：审查这次改动',
              'aria-label': '任务描述',
              disabled: creating,
              onChange: (event) => patchForm({ description: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'cmp-field', key: 'prompt' },
            h('label', { className: 'cmp-label' }, '初始任务'),
            h('textarea', {
              className: 'cmp-textarea',
              value: form.prompt,
              placeholder: '要它做的具体事情',
              'aria-label': '初始任务',
              disabled: creating,
              onChange: (event) => patchForm({ prompt: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'cmp-fields', key: 'route' },
            h(ModelSelect, {
              className: 'cmp-provider',
              value: form.provider,
              options: providerChoiceList(routes),
              placeholder: '渠道',
              emptyHint: '没有可用的渠道（LLM 服务未就绪）',
              ariaLabel: '新成员的 provider',
              testId: 'provider-select',
              disabled: creating,
              onChange: (value) => {
                const models = modelsOf(routes, value);
                patchForm({
                  provider: value,
                  model: models.length > 0 ? models[0].id : '',
                  effort: '',
                });
              },
            }),
            h(ModelSelect, {
              className: 'cmp-modelSel',
              value: form.model,
              groups: modelChoiceGroups(routes, form.provider),
              placeholder: '模型',
              emptyHint: form.provider === '' ? '先选渠道' : '这个渠道下没有可用模型',
              ariaLabel: '新成员的 model',
              testId: 'model-select',
              disabled: creating,
              onChange: (value) => patchForm({ model: value, effort: '' }),
            }),
            h('input', {
              type: 'text',
              className: 'cmp-input cmp-effort',
              value: form.effort,
              placeholder: '档位（可选，留空自动）',
              'aria-label': '新成员的推理档位',
              disabled: creating,
              onChange: (event) => patchForm({ effort: event.target.value }),
            }),
          ),
          formError === ''
            ? null
            : h('p', { className: 'cmp-notice cmp-noticeErr', key: 'err', role: 'status' }, formError),
          h(
            'div',
            { className: 'cmp-actions', key: 'actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn cmp-btnPrimary',
                disabled,
                onClick: () => {
                  void create();
                },
              },
              creating ? '创建中…' : '创建',
            ),
            h(
              'span',
              { className: 'cmp-guide' },
              kind === 'teammate'
                ? '队友会进团队名册，可以用 send_message 派活'
                : '子智能体只跑这一件任务，结果回给主 Agent',
            ),
          ),
        );

        return h(
          'div',
          { className: 'cmp-create' },
          h(
            'button',
            {
              type: 'button',
              className: 'cmp-createHead',
              'aria-expanded': createOpen,
              onClick: () => setCreateOpen(!createOpen),
            },
            caretIcon(createOpen),
            h('span', null, '＋ 新建队友 / 子智能体'),
          ),
          createOpen
            ? h(
                'div',
                { className: 'cmp-kinds' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-kind',
                    'aria-pressed': kind === 'teammate',
                    disabled: creating,
                    onClick: () => setKind('teammate'),
                  },
                  '队友',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-kind',
                    'aria-pressed': kind === 'subagent',
                    disabled: creating,
                    onClick: () => setKind('subagent'),
                  },
                  '子智能体',
                ),
              )
            : null,
          createOpen ? h('div', { className: 'cmp-createBody' }, fields) : null,
        );
      }

      /**
       * 点名表管理。
       *
       * 这是唯一能清掉「已经结束的成员」的地方：`members` 列表只列当前会话里还看得见
       * 的成员，子智能体一结束就消失，但点名表里的键还在，于是越堆越多。所以这里读的是
       * `settings.members` 的**全部键**，不是成员列表。
       *
       * 视觉上复用「新建队友」那套折叠头（cmp-createHead + caretIcon），同一块面板里
       * 的两个折叠区长得一样，不用再记一套样式。
       */
      function renderPins() {
        const count = fixedRows.length;
        const busyAny = pinsBusy !== '';
        const rows = fixedRows.map((row) => {
          const effortText = textOf(row.reasoningEffort);
          const modelText = row.valid
            ? row.provider + '/' + row.model + (effortText === '' ? '' : ' · ' + effortText)
            : '值不是合法路由';
          return h(
            'div',
            { className: 'cmp-pinRow', key: 'pin:' + row.key },
            h(
              'span',
              {
                className: row.valid ? 'cmp-pinKey' : 'cmp-pinKey cmp-pinStale',
                title: row.key,
              },
              row.key,
            ),
            h(
              'span',
              {
                className: row.valid ? 'cmp-pinModel' : 'cmp-pinModel cmp-modelNone',
                title: modelText,
              },
              modelText,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn cmp-pinBtn',
                disabled: busyAny || busy !== '',
                onClick: () => {
                  void clearPinned(row.key);
                },
              },
              pinsBusy === row.key ? '恢复中…' : '恢复继承',
            ),
          );
        });

        return h(
          'div',
          { className: 'cmp-pins' },
          h(
            'div',
            { className: 'cmp-pinHead' },
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-createHead',
                'aria-expanded': pinsOpen,
                onClick: () => {
                  setPinsConfirm(false);
                  setPinsOpen(!pinsOpen);
                },
              },
              caretIcon(pinsOpen),
              h('span', null, '点名表（' + String(count) + ' 条）'),
            ),
            pinsOpen && count > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-btn cmp-pinBtn',
                    disabled: busyAny || busy !== '',
                    onClick: () => setPinsConfirm(true),
                  },
                  pinsBusy === '*' ? '清空中…' : '全部清空',
                )
              : null,
          ),
          pinsOpen
            ? h(
                'div',
                { className: 'cmp-createBody' },
                h(
                  'p',
                  { className: 'cmp-guide' },
                  '这里列的是点名表里的全部键，含已经结束、列表里看不见的成员。恢复继承会把它从这个表里删掉。',
                ),
                pinsConfirm
                  ? h(
                      'div',
                      { className: 'cmp-bulkRow' },
                      h(
                        'span',
                        { className: 'cmp-bulkResult cmp-bulkWarn' },
                        '将清空全部 ' + String(count) + ' 条点名，这些成员之后都会跟随规则或继承主 Agent。',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'cmp-btn cmp-btnPrimary',
                          disabled: busyAny || busy !== '',
                          onClick: () => {
                            void clearAllPinned();
                          },
                        },
                        '确认清空',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'cmp-btn',
                          disabled: busyAny || busy !== '',
                          onClick: () => setPinsConfirm(false),
                        },
                        '取消',
                      ),
                    )
                  : null,
                count === 0
                  ? h('div', { className: 'cmp-empty' }, '点名表是空的，所有成员都按规则或继承走。')
                  : h('div', { className: 'cmp-list' }, rows),
              )
            : null,
        );
      }

      function renderEditor(member, key) {
        return h(
          'div',
          { className: 'cmp-editor' },
          h(
            'div',
            { className: 'cmp-fields' },
            h(ModelSelect, {
              className: 'cmp-provider',
              value: draft.provider,
              options: providerChoiceList(routes),
              placeholder: '渠道',
              emptyHint: '没有可用的渠道（LLM 服务未就绪）',
              ariaLabel: '成员的 provider',
              testId: 'provider-select',
              disabled: busy === key,
              onChange: (value) => {
                const models = modelsOf(routes, value);
                patchDraft({
                  provider: value,
                  model: models.length > 0 ? models[0].id : '',
                  effort: '',
                });
              },
            }),
            h(ModelSelect, {
              className: 'cmp-modelSel',
              value: draft.model,
              groups: modelChoiceGroups(routes, draft.provider),
              placeholder: '模型',
              emptyHint: draft.provider === '' ? '先选渠道' : '这个渠道下没有可用模型',
              ariaLabel: '成员的 model',
              testId: 'model-select',
              disabled: busy === key,
              onChange: (value) => patchDraft({ model: value, effort: '' }),
            }),
            h('input', {
              type: 'text',
              className: 'cmp-input cmp-effort',
              value: draft.effort,
              placeholder: '档位（可选，留空自动）',
              'aria-label': '推理档位',
              disabled: busy === key,
              onChange: (event) => patchDraft({ effort: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'cmp-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn cmp-btnPrimary',
                disabled: busy === key || draft.provider === '' || draft.model === '',
                onClick: () => {
                  void submit(member);
                },
              },
              busy === key ? '应用中…' : '应用',
            ),
            member.isMember && fixedNames.indexOf(member.name) >= 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-btn',
                    disabled: busy === key,
                    onClick: () => {
                      void clearRoute(member);
                    },
                  },
                  '恢复继承',
                )
              : null,
          ),
        );
      }

      const rows = members.map((member) => {
        const key = memberKey(member);
        const isOpen = expanded === key;
        const effort = member.reasoningEffort;
        const status = memberStatus(member);
        return h(
          'div',
          { className: 'cmp-row', key },
          h(
            'button',
            {
              type: 'button',
              className: 'cmp-rowBtn',
              'aria-expanded': isOpen,
              title: member.label === '' ? member.name : member.name + ' · ' + member.label,
              onClick: () => toggleRow(member),
            },
            memberGlyph(member.isMember),
            h(
              'span',
              { className: 'cmp-rowMain' },
              h('span', { className: 'cmp-name' }, member.name === '' ? '子智能体' : member.name),
              member.label === '' ? null : h('span', { className: 'cmp-sub' }, member.label),
            ),
            h('span', { className: status.className }, status.label),
            h(
              'span',
              {
                className: member.model === '' ? 'cmp-model cmp-modelNone' : 'cmp-model',
                title: member.model === '' ? '继承' : member.provider + '/' + member.model,
              },
              member.model === ''
                ? '继承'
                : effort === ''
                  ? member.model
                  : member.model + ' · ' + effort,
            ),
          ),
          isOpen ? renderEditor(member, key) : null,
        );
      });

      let body = null;
      if (phase === 'idle' || phase === 'loading') {
        body = h('div', { className: 'cmp-empty' }, '加载中…');
      } else if (phase === 'error') {
        body = h(
          'div',
          null,
          h('p', { className: 'cmp-notice cmp-noticeErr' }, loadError),
          h(
            'div',
            { className: 'cmp-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'cmp-btn',
                onClick: () => setReloadTick((tick) => tick + 1),
              },
              '重新加载',
            ),
          ),
        );
      } else if (members.length === 0) {
        body = h(
          'div',
          null,
          h('div', { className: 'cmp-empty' }, '当前会话还没有队友或子智能体'),
          h(
            'p',
            { className: 'cmp-guide' },
            '用上面的表单建一个；也可以直接在对话里让主 Agent 派活，派出来的成员会自动出现在这里。',
          ),
        );
      } else {
        body = h('div', { className: 'cmp-list' }, rows);
      }

      const anchorStyle =
        anchor === null
          ? {
              position: 'fixed',
              top: '56px',
              right: '16px',
              width: '340px',
              maxHeight: '360px',
            }
          : {
              position: 'fixed',
              top: String(anchor.top) + 'px',
              left: String(anchor.left) + 'px',
              width: String(anchor.width) + 'px',
              maxHeight: String(anchor.maxHeight) + 'px',
            };

      return h(
        'div',
        { className: 'cmp-root', ref: rootRef },
        styleTag(),
        h(
          'button',
          {
            type: 'button',
            className: 'cmp-trigger',
            ref: triggerRef,
            title: '给队友或子智能体指定模型',
            'aria-label': '模型',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => {
              setNotice(null);
              setOpen(!open);
            },
          },
          slidersIcon(),
          h('span', null, '模型'),
        ),
        open
          ? h(
              'div',
              {
                className: 'cmp-panel',
                role: 'dialog',
                'aria-label': '给成员换模型',
                style: anchorStyle,
              },
              h(
                'div',
                { className: 'cmp-head' },
                h('span', { className: 'cmp-headTitle' }, '成员模型'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cmp-close',
                    'aria-label': '关闭',
                    onClick: () => setOpen(false),
                  },
                  '×',
                ),
              ),
              h(
                'p',
                { className: 'cmp-hint' },
                '点成员即可换模型：正在跑的下一步就换，没在跑的等它下次被唤醒时换——都不需要重启',
              ),
              notice === null
                ? null
                : h(
                    'p',
                    {
                      className:
                        notice.kind === 'ok' ? 'cmp-notice cmp-noticeOk' : 'cmp-notice cmp-noticeErr',
                      role: 'status',
                    },
                    notice.text,
                  ),
              routes.length === 0
                ? h(
                    'p',
                    { className: 'cmp-warn' },
                    '没有可用的模型路由（LLM 服务未就绪），暂时无法选择模型。',
                  )
                : null,
              // 本对话默认：主动选一次，这个对话里派活都用它，不再询问。
              phase === 'ready'
                ? h(
                    'div',
                    { className: 'cmp-sessionBlock' },
                    h(
                      'div',
                      { className: 'cmp-sessionHead' },
                      h('span', { className: 'cmp-sessionLabel' }, '本对话默认'),
                      h(
                        'span',
                        { className: 'cmp-bulkNote' },
                        sessionDefault === null
                          ? '还没设，第一次派活会问你一次'
                          : '之后派活不再询问',
                      ),
                    ),
                    h(ModelSelect, {
                      value: sessionValue(),
                      options: sessionOptions(),
                      placeholder: '继承主 Agent',
                      emptyHint: '没有可用的模型路由（LLM 服务未就绪）',
                      ariaLabel: '本对话默认模型',
                      testId: 'session-default-select',
                      disabled: busy === 'session',
                      onChange: (value) => {
                        void chooseSessionDefault(value);
                      },
                    }),
                  )
                : null,
              // 批量条常驻：一眼可见，不折叠。数据没读出来时先不画（没有 routes 无可选）。
              phase === 'ready' ? renderBulkBar() : null,
              // 失败红条紧贴批量条下方、成员列表上方：换模型失败的原因要跟操作挨在一起。
              // 没有失败时 renderErrorBar() 返回 null，整块不占位。
              phase === 'ready' ? renderErrorBar() : null,
              // 新建区只在数据读出来之后给：没路由时它必然提交失败，不如先让用户看警告。
              phase === 'ready' ? renderCreateForm() : null,
              body,
              // 点名表管理放最底下：它是清理用的，不该抢常用操作的视线。
              phase === 'ready' ? renderPins() : null,
            )
          : null,
      );
    }

    /* ── 挂载 ─────────────────────────────────────────────────────────────── */

    /**
     * 注册两个互不影响的插槽：
     *  - `plugins.bundle.config`（插件管理页的设置卡片）；
     *  - `conversation.session.header.actions`（对话头部的「模型」入口）。
     *
     * `ctx.slots.inject(name, cb)` 的回调会在插槽出现时执行、消失时清理，
     * 且可能**重复执行**，所以这里每次都是纯注册，不缓存跨次状态。
     */
    function apply(ctx) {
      const slots = ctx === null || ctx === undefined ? undefined : ctx.slots;
      if (
        slots === undefined ||
        slots === null ||
        typeof slots.inject !== 'function' ||
        typeof slots.register !== 'function'
      ) {
        return () => {};
      }
      const disposeCard = slots.inject(SLOT_NAME, () =>
        slots.register({ name: SLOT_NAME, key: SLOT_KEY }, Panel),
      );
      const disposePicker = slots.inject(HEADER_SLOT, () =>
        slots.register({ name: HEADER_SLOT, id: PICKER_ID, order: 15 }, PickerAction),
      );
      return () => {
        if (typeof disposeCard === 'function') disposeCard();
        if (typeof disposePicker === 'function') disposePicker();
      };
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
