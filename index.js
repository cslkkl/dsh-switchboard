/**
 * dsh-model-roster —— 宿主半边。
 *
 * 让**子智能体**（`subagent` 工具、`workflow` 的 `agent()`）与**智能体团队的队友**
 * 跑在与主 Agent 不同的模型上，并且按规则挑。
 *
 * ## 为什么走这条缝
 *
 * - 团队工具 `spawn_teammate` 没有模型参数，底层 `startActivation` 也不传
 *   `agentOptions`（`dsh-experimental-agent-team` 的 `spawnAdmitted`），所以
 *   外面没有任何参数缝可以塞模型。
 * - 但每个本地子会话都是**同一进程里的一等 Agent**：创建后发 `agent/created`，
 *   而 `agent/request` 是决定「这一步发给哪个 provider/model」的 waterfall。
 *   在这个 Agent 自己的 ctx 上挂覆盖，只影响它自己，Agent 销毁时自动回收。
 * - 这对缝正是官方 `installModelSelection()` 用的（`dsh-agent` 的
 *   `model-selection.js`：`system-prompt/assemble` 改 `{{model}}` 变量 +
 *   `agent/request` 改请求路由）。这里不 import 官方包 —— 外部插件解析到第二份
 *   模块实例没有好处，而这两个事件都是公开契约。
 *
 * ## 为什么必须一起改 reasoningEffort
 *
 * `cpa-*` 路由在 provider profile 上带**路由级默认档位**（`reasoning: high`，
 * 见 `dsh-cpa-switch` 的 `REASONING_DEFAULT`），pi-ai 解析时是
 * `resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)`。
 * 也就是说：只清掉请求里的 effort **不等于**没有 effort，而是回落到路由默认值。
 * 目标模型不支持那个档位时请求直接失败（实测报
 * `UNSUPPORTED_REASONING_EFFORT`）。所以换路由时必须显式给一个**该模型支持**的档位。
 *
 * ## 状态放在哪
 *
 * 规则文件 `$DSH_HOME/storages/dsh-model-roster/rules.json`，优先于 patch 里的
 * `config`。原因：设置页写回 patch 会触发 fiber 重建（cpa-switch 的踩坑记录），
 * 而这份配置只影响下一次委派，没有必要重建插件树。patch 里的 config 仍是
 * 有效入口（手写/首次默认），文件只是运行期覆盖层。
 *
 * @module dsh-model-roster
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-model-roster';

/** 子 Agent 覆盖用的默认最大深度：只作用于直接子代，避免深层嵌套被意外改写。 */
const DEFAULT_MAX_DEPTH = 1;

function dshHome() {
  const override = (process.env.DSH_HOME ?? '').trim();
  return override === '' ? join(homedir(), '.dsh') : override;
}

function storageDir() {
  return join(dshHome(), 'storages', 'dsh-model-roster');
}

function rulesPath() {
  return join(storageDir(), 'rules.json');
}

function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function appendProbe(entry) {
  try {
    const dir = storageDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'probe.jsonl'), JSON.stringify({ time: Date.now(), ...entry }) + '\n', {
      encoding: 'utf8',
      flag: 'a',
    });
  } catch {
    /* 诊断写失败不该影响委派 */
  }
}

/**
 * 最近一次委派的解析结果，给设置页看。
 *
 * ⚠️ 一次委派会写**两条**探针：先写「路由/档位解析」，再写「已应用」。所以按
 * childId 合并后再取最后 N 个 —— 直接 tail 会把同一孩子的两条当成两次委派。
 */
function readRecentProbes(limit = 12) {
  try {
    const text = readFileSync(join(storageDir(), 'probe.jsonl'), 'utf8');
    const byChild = new Map();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry?.childId !== 'string') continue;
      byChild.set(entry.childId, { ...(byChild.get(entry.childId) ?? {}), ...entry });
    }
    return [...byChild.values()].slice(-limit).reverse();
  } catch {
    return [];
  }
}

/* ── 规则 ─────────────────────────────────────────────────────────────── */

/** 一条路由选择结果。`reasoningEffort: 'none'` 表示「请求里不带 effort」。 */
function asRoute(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  const { provider, model, reasoningEffort } = value;
  if (typeof provider !== 'string' || provider === '') return undefined;
  if (typeof model !== 'string' || model === '') return undefined;
  const effort =
    typeof reasoningEffort === 'string' && reasoningEffort !== '' ? reasoningEffort.trim() : undefined;
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

/** 归一化规则表：丢掉形状不对的条目，而不是让一条坏规则废掉整份配置。 */
function normalizeRules(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const rules = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const match = typeof item.match === 'string' ? item.match.trim() : '';
    const route = asRoute(item);
    if (match === '' || route === undefined) continue;
    rules.push({ match, ...route });
  }
  return rules;
}

/**
 * 有效设置 = patch 配置 ← 规则文件覆盖。
 *
 * `members` 是「按成员点名」的一层：它比 `rules` 优先，因为用户是在界面上
 * 对着某个具体成员点选模型，比通配规则更明确。
 */
function effectiveSettings(config) {
  const patch = config ?? {};
  const file = readJsonFile(rulesPath()) ?? {};
  const enabled = typeof file.enabled === 'boolean' ? file.enabled : patch.enabled !== false;
  const rules = normalizeRules(file.rules !== undefined ? file.rules : patch.rules);
  const defaultRoute = asRoute(file.defaultRoute !== undefined ? file.defaultRoute : patch.defaultRoute);
  const members = normalizeMembers(file.members !== undefined ? file.members : patch.members);
  // 「本对话默认」：按 Lead 会话 id 存，回答完「首次创建时问一次」就落在这里。
  const sessions = normalizeMembers(file.sessions);
  /* 已经问过的会话（值=时间戳字符串）。**不能用 normalizeMembers 处理** ——
     它要求值是路由对象，时间戳会被当成非法值丢掉，于是每个会话被反复追问。 */
  const asked = normalizeAsked(file.asked);
  const maxDepth = Number.isSafeInteger(file.maxDepth)
    ? file.maxDepth
    : Number.isSafeInteger(patch.maxDepth)
      ? patch.maxDepth
      : DEFAULT_MAX_DEPTH;
  const applyToFork = typeof file.applyToFork === 'boolean' ? file.applyToFork : patch.applyToFork === true;
  const askOnFirst = typeof file.askOnFirst === 'boolean' ? file.askOnFirst : patch.askOnFirst !== false;
  return { enabled, rules, members, sessions, asked, defaultRoute, maxDepth, applyToFork, askOnFirst };
}

/**
 * 「已问过」表：`{ "<leadSessionId>": "<ISO 时间戳>" }`。
 *
 * 只要求「键非空、值是字符串」，值本身不参与匹配 —— 它只是「别再问」的标记。
 * 写成独立函数是因为拿 `normalizeMembers` 会把它整表过滤掉（那里要求值是路由）。
 */
function normalizeAsked(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const asked = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.trim() === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    asked[key] = String(value);
  }
  return asked;
}

/** 按成员点名的覆盖表：`{ "<name>": {provider, model, reasoningEffort?} }`。 */function normalizeMembers(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const members = {};
  for (const [name, value] of Object.entries(raw)) {
    const route = asRoute(value);
    if (name.trim() === '' || route === undefined) continue;
    members[name] = route;
  }
  return members;
}

/**
 * 命中规则：按成员点名 → 精确名字 → 包含匹配。名字优先于委派描述。
 *
 * 点名表支持两种键：
 * - 队友名（`cheap-two`）—— 队友名由 Lead 起、可预测，是最自然的键；
 * - `#<childId>` —— 子智能体没有名字，但它的会话 id 在冷恢复后**不变**，
 *   所以点一个子智能体换的模型也能跟着它回来。
 */
function resolveRoute(settings, { memberName, label, childId, leadId }) {
  const nameKey = (memberName ?? '').trim();
  const exact = nameKey === '' ? undefined : settings.members[nameKey];
  if (exact !== undefined) return { ...exact, hit: `member:${nameKey}` };

  const idKey = typeof childId === 'string' && childId !== '' ? `#${childId}` : '';
  const byId = idKey === '' ? undefined : settings.members[idKey];
  if (byId !== undefined) return { ...byId, hit: `child:${childId}` };

  // 「本对话默认」优先于全局规则：它是用户在这一次对话里明确回答过的选择。
  const sessionRoute =
    typeof leadId === 'string' && leadId !== '' ? settings.sessions?.[leadId] : undefined;
  if (sessionRoute !== undefined) return { ...sessionRoute, hit: 'session' };

  const needleName = (memberName ?? '').trim().toLowerCase();
  const needleLabel = (label ?? '').trim().toLowerCase();
  for (const rule of settings.rules) {
    const match = rule.match.toLowerCase();
    if (needleName !== '' && match === needleName) return { ...rule, hit: `name:${rule.match}` };
  }
  for (const rule of settings.rules) {
    const match = rule.match.toLowerCase();
    if (needleName !== '' && needleName.includes(match)) return { ...rule, hit: `name~${rule.match}` };
    if (needleLabel !== '' && needleLabel.includes(match)) return { ...rule, hit: `label~${rule.match}` };
  }
  if (settings.defaultRoute !== undefined) {
    return { ...settings.defaultRoute, hit: '(default)' };
  }
  return undefined;
}

/**
 * 挑一个目标模型**真正接受**的档位。
 *
 * 为什么不能只算一次：`off` 不是万能兜底 —— 实测 `cpa-trae/trae/glm-5.3-flash`
 * 连 `off` 都拒（该模型不声明任何思考档位），而完全不发 effort 又会回落到
 * 路由级默认 `high`，同样报错。所以这里按「配置点名 → 模型默认 → 逐个声明档位 →
 * `off` → 什么都不发」的顺序**逐个交给适配器验证**，第一个通过的就是答案。
 *
 * @returns `{ effort, reasoning }`：可用的档位（可能为 undefined，表示请求里不带
 *   effort），以及模型的档位元数据（写进诊断，便于解释为什么选不中）。
 * @throws 当所有候选都被拒绝时，附上适配器的最后一条诊断。
 */
async function pickEffort(llm, route, options = {}) {
  if (llm === undefined) return { effort: route.reasoningEffort };
  const info = await llm.resolveModelInfo(route.provider, route.model);
  const reasoning = info?.reasoning;
  // 顺序：配置点名 → 模型默认 → 逐个声明档位 → `off`。
  // `undefined`（完全不发 effort）**默认不作为候选**：多数 cpa-* 路由带路由级
  // 默认档位，不发 effort 会回落到它，而不是「没有思考档位」。只有显式
  // 允许（allowNoEffort）时才试。
  const raw = [
    route.reasoningEffort,
    reasoning?.defaultEffort,
    ...(reasoning?.efforts ?? []).map((effort) => effort.id),
    'off',
    ...(options.allowNoEffort === true ? [undefined] : []),
  ];
  const candidates = [];
  for (const value of raw) {
    if (value === undefined && options.allowNoEffort !== true) continue;
    if (!candidates.includes(value)) candidates.push(value);
  }

  const attempts = [];
  let lastError;
  for (const candidate of candidates) {
    try {
      await llm.resolveCallConfig({
        provider: route.provider,
        model: route.model,
        ...(candidate === undefined ? {} : { reasoningEffort: candidate }),
      });
      attempts.push({ candidate: candidate ?? null, ok: true });
      return { effort: candidate, reasoning, attempts };
    } catch (error) {
      lastError = error;
      attempts.push({
        candidate: candidate ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const supportsNoEffort = reasoning === undefined;
  const hint = supportsNoEffort
    ? '该模型不声明任何思考档位（pi-ai 只接受「不发 effort」），但这条路由设置了路由级默认档位，' +
      '两者冲突：关闭该 provider 的档位开关（CPA Switch 面板的「思考档位」）后即可选用，' +
      '或改用声明了档位的模型。'
    : '该模型声明的档位都不被当前路由接受。';
  throw Object.assign(
    new Error(`${lastError instanceof Error ? lastError.message : String(lastError)} —— ${hint}`),
    { reasoning, attempts, hint },
  );
}

/* ── 注入 ─────────────────────────────────────────────────────────────── */

/**
 * 在某个 Agent 自己的 ctx 上安装路由覆盖，两条路一起上：
 *
 * 1. **改写 `agent.options`**：`prepareRequest()` 每一步都读它
 *    （`dsh-agent-loop/lib/index.js:1168` 起），而 loop 与 Agent 共享同一个
 *    options 引用（`:774`）。改这一处，`request/header`、assistant 消息的
 *    model source、以及 `list_agents` 报的 model 全都跟着变——这是与
 *    `dsh-plugin-team-model-routing` 相同的落点。
 * 2. **`agent/request` waterfall**：兜底。options 万一被别处重置（或
 *    `maxTokens` 之类被重建），请求侧仍然被钉住。
 *
 * `system-prompt/assemble` 只改 `{{model}}` 变量，让子 Agent 的自我认知一致。
 */
function installRoute(agent, route) {
  const { provider, model, reasoningEffort } = route;

  // options 是运行时对象（`this.options = options`，未冻结）；类型上是 readonly，
  // 这里按「插件改官方运行时状态」的有意越权处理，并在 probe 里留痕。
  let optionsPatched = false;
  try {
    Object.assign(agent.options, {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    optionsPatched = true;
  } catch {
    optionsPatched = false;
  }

  return {
    optionsPatched,
    dispose: agent.ctx.effect(() => {
      const offAssemble = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next();
        return { ...assembled, variables: { ...assembled.variables, provider, model } };
      });
      const offRequest = agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next();
        const { reasoningEffort: _drop, ...rest } = resolved;
        return {
          ...rest,
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };
      });
      return () => {
        offAssemble();
        offRequest();
      };
    }),
  };
}

/** 从子会话的 descriptor 事件里读委派标签（子智能体与队友都写它）。 */
function readDescriptor(session) {
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'subagent/descriptor') return event.data ?? {};
    }
  } catch {
    /* 读不到按空处理 */
  }
  return {};
}

/**
 * 队友名字：Lead 的日志里有 `team/member`，其 id 就是子会话 id。
 *
 * ⚠️ 必须走 `ctx.get('agents')`：cordis 里直接 `ctx.agents` 需要在自己的
 * `inject` 里声明，否则抛「cannot get property without inject」—— 而这句
 * 在 try 里，症状会是**静默拿不到名字**（本插件现场踩过）。
 */
function readMemberName(ctx, agent, header) {
  if (typeof header.parentSession !== 'string') return { name: undefined, reason: 'no-parent' };
  const agents = ctx.get('agents');
  if (agents === undefined) return { name: undefined, reason: 'no-agents-service' };
  try {
    const parent = agents.get(header.parentSession);
    if (parent === undefined) return { name: undefined, reason: 'parent-not-live' };
    let seen = 0;
    for (const event of parent.session.snapshotEvents()) {
      if (event.type !== 'team/member') continue;
      seen += 1;
      const member = event.data?.member;
      if (member?.id === agent.id && typeof member.name === 'string') {
        return { name: member.name, reason: 'ok' };
      }
    }
    return { name: undefined, reason: `no-own-member-event(${seen} team/member events)` };
  } catch (error) {
    return { name: undefined, reason: `read-failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/* ── 存活子 Agent 登记（给「点成员换模型」用） ───────────────────────── */

/**
 * childId → { agent, memberName, label }。
 *
 * 为什么要存 Agent 引用：用户在面板上点一个成员换模型时，那个成员可能**正在跑**。
 * `agent.options` 每一步都被读（`prepareRequest`），所以改它能立刻影响下一步，
 * 不用等下次 spawn —— 这是「点了就生效」的全部机制。
 */
function createChildRegistry() {
  const live = new Map();
  return {
    add(agent, meta) {
      live.set(agent.id, { agent, ...meta });
    },
    remove(id) {
      live.delete(id);
    },
    get(id) {
      return live.get(id);
    },
    values() {
      return [...live.values()];
    },
    clear() {
      live.clear();
    },
  };
}

/** 一个成员/子代理在界面上的行：名字、id、当前实际路由。 */
function describeChild(ctx, entry) {
  const { agent, memberName, label } = entry;
  const options = agent.options ?? {};
  const header = agent.session.header;
  return {
    childId: agent.id,
    name: memberName ?? label ?? '',
    isMember: memberName !== undefined,
    label: label ?? '',
    provider: options.provider ?? '',
    model: options.model ?? '',
    reasoningEffort: options.reasoningEffort ?? null,
    depth: header.delegationDepth ?? 0,
  };
}

/**
 * 列出某个 Lead 下的全部目标：存活 Agent + 只存在于团队日志里的成员。
 *
 * 批量换模型要同时覆盖这两类 —— 存活的能立刻改，已回收的只能写点名表。
 * 返回的每一项都带 `persistKey`：队友用名字（跨会话复用），子智能体用
 * `#<childId>`（冷恢复后 id 不变）。
 *
 * @returns {{ live: Array, offline: Array }}
 */
function collectTargets(ctx, registry, leadSessionId) {
  const live = [];
  const liveIds = new Set();
  for (const entry of registry.values()) {
    if (entry.parentSessionId !== leadSessionId) continue;
    live.push(entry);
    liveIds.add(entry.agent.id);
  }

  const offline = [];
  const agents = ctx.get('agents');
  const lead = typeof leadSessionId === 'string' ? agents?.get(leadSessionId) : undefined;
  if (lead !== undefined) {
    try {
      const latest = new Map();
      for (const event of lead.session.snapshotEvents()) {
        if (event.type !== 'team/member') continue;
        const member = event.data?.member;
        if (typeof member?.id !== 'string' || typeof member?.name !== 'string') continue;
        latest.set(member.name, member);
      }
      for (const member of latest.values()) {
        if (liveIds.has(member.id)) continue;
        offline.push({ childId: member.id, name: member.name, isMember: true });
      }
    } catch {
      /* Lead 日志读不到就只处理存活的 */
    }
  }

  return { live, offline };
}

/**
 * 一个 Lead 会话下的成员与子代理（存活 + 团队日志里见过的）。
 *
 * ⚠️ 显示规则（这里踩过坑）：**未运行的成员要优先显示「点名表里设定的路由」**，
 * 而不是它上次实际跑的路由。否则用户点了「全部换成 X」、9 条都写进表了，
 * 列表却还显示旧的 /「继承」——看起来像没生效。
 * 每一项带 `pending`：true 表示「已设定，等它下次唤醒」。
 */
function describeTeam(ctx, registry, leadSessionId, settings) {
  const members = [];
  const seen = new Set();
  const overrides = settings?.members ?? {};

  // 历史成员没有存活 Agent，只能从探针日志里回读它上次实际用的路由。
  const knownRoutes = new Map();
  for (const event of readRecentProbes(200)) {
    if (event.applied !== undefined) knownRoutes.set(event.childId, event.applied);
    else if (event.resolved !== undefined) knownRoutes.set(event.childId, event.resolved);
  }

  for (const entry of registry.values()) {
    if (entry.parentSessionId !== leadSessionId) continue;
    const row = describeChild(ctx, entry);
    // 存活成员：options 就是真值；与点名表不一致说明表里那条还没轮到它。
    const wanted = entry.memberName === undefined ? overrides[`#${entry.agent.id}`] : overrides[entry.memberName];
    members.push({
      ...row,
      pending: wanted !== undefined && (wanted.model !== row.model || wanted.provider !== row.provider),
    });
    seen.add(entry.agent.id);
  }

  // 队伍里已经冷下来的成员也列出来（只存在于 Lead 日志里），方便提前配好模型。
  const agents = ctx.get('agents');
  const lead = typeof leadSessionId === 'string' ? agents?.get(leadSessionId) : undefined;
  if (lead !== undefined) {
    try {
      const latest = new Map();
      for (const event of lead.session.snapshotEvents()) {
        if (event.type !== 'team/member') continue;
        const member = event.data?.member;
        if (typeof member?.id !== 'string' || typeof member?.name !== 'string') continue;
        latest.set(member.name, member);
      }
      for (const member of latest.values()) {
        if (seen.has(member.id)) continue;
        const live = agents?.get(member.id);
        const known = knownRoutes.get(member.id);
        const wanted = overrides[member.name] ?? overrides[`#${member.id}`];
        // 已回收的成员：点名表 > 上次实跑记录。
        const source = live !== undefined ? undefined : wanted ?? known;
        members.push({
          childId: member.id,
          name: member.name,
          isMember: true,
          label: member.description ?? '',
          provider: live?.options?.provider ?? source?.provider ?? '',
          model: live?.options?.model ?? source?.model ?? '',
          reasoningEffort: live?.options?.reasoningEffort ?? source?.reasoningEffort ?? null,
          depth: 1,
          live: live !== undefined,
          pending: live === undefined && wanted !== undefined,
        });
      }
    } catch {
      /* Lead 日志读不到就只报存活的 */
    }
  }

  return members;
}

/* ── 创建成员（队友 / 子智能体） ───────────────────────────────────────── */

/**
 * 在某个 Lead 会话下创建一个队友或子智能体，并让它直接跑在指定模型上。
 *
 * 两条路不一样，原因是官方 API 不对称：
 * - **队友**：`agentTeams.spawnTeammate()` 只接受 provider *名字*，不接 `agentOptions`。
 *   所以先把「点名表」写好，再 spawn —— 真正换模型发生在 `agent/created` 钩子里
 *   （与本插件其它路径同一套逻辑，不另开分支）。
 * - **子智能体**：`subagents.startActivation()` 的 `request.agentOptions` 是官方支持的，
 *   直接随请求传下去最省事，也让 `subagent/descriptor` 记下真实路由（冷恢复不会丢）。
 */
async function spawnChild(ctx, registry, request) {
  const agents = ctx.get('agents');
  if (agents === undefined) throw new Error('agents 服务不可用');
  const lead = agents.get(request.lead);
  if (lead === undefined) throw new Error(`Lead 会话 ${request.lead} 当前不在运行`);

  const prompt = [{ type: 'text', text: request.prompt }];
  const label = request.description;
  // startActivation / spawnTeammate 都把 signal 当必填（内部直接 throwIfAborted），
  // 这里给一个受超时约束的信号：创建不该无限挂住。
  const signal = AbortSignal.timeout(120000);

  if (request.kind === 'teammate') {
    const teams = ctx.get('agentTeams');
    if (teams === undefined) throw new Error('当前 profile 没有挂载智能体团队服务（agentTeams）');
    // 先落点名表，再 spawn：agent/created 钩子读的就是它。
    const settings = effectiveSettings(request.config);
    writeJsonFile(rulesPath(), {
      ...settings,
      members: {
        ...settings.members,
        [request.name]: { ...request.route, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) },
      },
    });
    const spawned = await teams.spawnTeammate(lead, {
      name: request.name,
      description: request.description,
      prompt,
      context: 'fresh',
      provider: 'spawn',
      signal,
    });
    return { kind: 'teammate', member: spawned.member ?? spawned };
  }

  const subagents = ctx.get('subagents');
  if (subagents === undefined) throw new Error('subagents 服务不可用');
  const started = await subagents.startActivation({
    provider: 'spawn',
    label,
    delivery: 'parent',
    request: {
      prompt,
      parent: lead,
      agentOptions: {
        provider: request.route.provider,
        model: request.route.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      },
    },
    signal,
  });
  return { kind: 'subagent', childId: started.childId };
}

/* ── 首次创建时询问 ───────────────────────────────────────────────────── */

/**
 * 一个会话里第一次派活时，问用户「本次和以后用哪个模型」。
 *
 * 走官方的 `userQuestions` 服务（就是 `ask_user_question` 背后那个），所以问题
 * 会出现在对话流里、带选项卡片，和其它提问长得一样。
 *
 * 三条纪律：
 * 1. **不阻塞 spawn**：`ask()` 会等到用户回答，所以这里 fire-and-forget，
 *    子智能体先用继承路由跑起来，回答完再改（`applyAnswer`）。
 * 2. **先记账再问**：把 leadId 写进 `asked` 之后才发问，避免同一个会话里
 *    并发创建时弹两次。问失败也不清账 —— 宁可不问，不要反复骚扰。
 * 3. **只问「没被明确指定」的情况**：命中点名表或规则时用户已经表过态了。
 *
 * @returns 是否真的发起了询问（调用方只用于日志）。
 */
function askOnceForSession(ctx, config, leadAgent, childId) {
  // 没人回答就放弃的时限：够用户切回来看一眼，又不至于让「待回答」挂一整天。
  const ASK_TIMEOUT_MS_LOCAL = 120000;
  const settings = effectiveSettings(config);
  if (!settings.enabled || !settings.askOnFirst) return false;
  const leadId = leadAgent.id;
  if (settings.asked[leadId] !== undefined) {
    appendProbe({ action: 'ask-skip', lead: leadId, why: 'already-asked' });
    return false;
  }

  const questions = ctx.get('userQuestions');
  if (questions === undefined) {
    appendProbe({ action: 'ask-skip', lead: leadId, why: 'no-userQuestions-service' });
    return false;
  }

  // 先记账：并发创建时第二个孩子不会再问。
  const marked = { ...readJsonFile(rulesPath()) };
  marked.asked = { ...(marked.asked ?? {}), [leadId]: new Date().toISOString() };
  writeJsonFile(rulesPath(), marked);

  const llm = ctx.get('llm');

  const request = {
    agent: leadAgent,
    questions: [
      {
        id: 'model-roster-default',
        header: '子智能体模型',
        question:
          '这个对话里创建子智能体和队友时，用哪个模型？选完会作为本对话的默认，之后每次派活都用它。',
        // 先放「继承」，真实选项在 ask 之前异步补齐（见下面的 buildOptions）。
        options: [{ label: '继承主 Agent', description: '不干预，用我当前这个模型' }],
      },
    ],
  };

  void (async () => {
    /* 超时闸：没人回答就放弃，别让「待回答」一直挂着。
       官方 `ask()` 接受 AbortSignal，abort 后抛 ASK_ABORTED，这里接住即可。
       标记不清 —— 同一个会话问过一次就不再骚扰，宁可少问。 */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS_LOCAL);
    request.signal = controller.signal;
    try {
      const options = await buildAskOptions(llm, request.questions[0].options);
      request.questions[0].options = options;

      const answer = await questions.ask(request);
      /* 应答形状：`{ answers: [{ id, selected: string[], custom? }] }` ——
         `selected` 里是选项的 **label 文本**，不是索引（官方 answerSchema）。 */
      const batch = Array.isArray(answer?.answers) ? answer.answers : [];
      const first =
        batch.find((item) => typeof item === 'object' && item !== null && !Array.isArray(item)) ?? null;
      const selected = Array.isArray(first?.selected) ? first.selected : [];
      const pickedLabel = typeof selected[0] === 'string' ? selected[0] : '';
      const chosen =
        pickedLabel === ''
          ? undefined
          : options.find((option) => option.label === pickedLabel) ??
            // 用户可能在输入框里自己打了模型名：认 `provider/model` 这种写法。
            (/^[\w.-]+\/[\w.\-/]+$/.test(pickedLabel)
              ? { label: pickedLabel, description: pickedLabel }
              : undefined);
      if (chosen === undefined) return; // 跳过 / 超时 / 没认出来：保持继承

      const current = readJsonFile(rulesPath()) ?? {};
      const sessions = { ...(current.sessions ?? {}) };
      if (chosen.label === '继承主 Agent') {
        delete sessions[leadId];
      } else {
        const at = String(chosen.description ?? '').indexOf('/');
        if (at <= 0) return;
        sessions[leadId] = {
          provider: String(chosen.description).slice(0, at),
          model: String(chosen.description).slice(at + 1),
        };
      }
      writeJsonFile(rulesPath(), { ...current, sessions });

      appendProbe({ action: 'asked-first', lead: leadId, answer: chosen.label });

      // 「本次」也生效：把刚创建的那个孩子直接改过来（它还活着才有意义）。
      if (chosen.label !== '继承主 Agent' && typeof childId === 'string' && childId !== '') {
        const entry = registry.get(childId);
        if (entry !== undefined) {
          const route = sessions[leadId];
          if (route !== undefined) {
            try {
              installRoute(entry.agent, route);
              appendProbe({ action: 'asked-first-applied', childId, route: `${route.provider}/${route.model}` });
            } catch {
              /* 改不动就算了，下一次创建会走新默认 */
            }
          }
        }
      }
    } catch (error) {
      /* 超时 / 被取消 / 无应答方：保持继承，不再追问。区分超时只是为了留痕。 */
      const aborted = controller.signal.aborted;
      appendProbe({
        action: aborted ? 'ask-timeout' : 'ask-failed',
        lead: leadId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  })();

  return true;
}

/**
 * 提问用的候选：第一项永远是「继承主 Agent」，后面每个渠道取它的头一个模型，
 * 最多 6 个。这里刻意不列全量模型 —— 提问卡片不是模型目录，长了没人看。
 */async function buildAskOptions(llm, head) {
  const options = [...head];
  if (llm === undefined) return options;
  let seen = 0;
  const failed = [];
  for (const provider of llm.listProviders()) {
    if (seen >= 6) break;
    let models = [];
    try {
      models = await llm.listModels(provider.id);
    } catch (error) {
      // 某个渠道读不出模型不该让整个提问变窄，但失败原因要留痕，便于排查。
      failed.push({ provider: provider.id, error: error instanceof Error ? error.message : String(error) });
      models = [];
    }
    const first = Array.isArray(models) ? models[0] : undefined;
    if (first === undefined) continue;
    options.push({
      label: (first.name || first.id) + ' · ' + (provider.name || provider.id),
      description: provider.id + '/' + first.id,
    });
    seen += 1;
  }
  if (failed.length > 0) appendProbe({ action: 'ask-options-partial', failed });
  return options;
}

/* ── HTTP 路由（给设置页） ─────────────────────────────────────────────── */

/** 可选的模型路由目录：provider → models。读不到就返回空表，界面提示即可。 */
async function describeRoutes(ctx) {
  const llm = ctx.get('llm');
  if (llm === undefined) return [];
  const out = [];
  for (const provider of llm.listProviders()) {
    let models = [];
    try {
      models = await llm.listModels(provider.id);
    } catch {
      models = [];
    }
    out.push({
      provider: provider.id,
      name: provider.name,
      models: models.map((model) => ({ id: model.id, name: model.name })),
    });
  }
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 读请求体；坏 JSON 返回 undefined。 */
async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function apply(ctx, config) {
  const registry = createChildRegistry();

  /* 委派时的实际覆盖 */
  ctx.effect(() => {
    const disposers = new Map();

    const offCreated = ctx.on('agent/created', async ({ agent }) => {
      const settings = effectiveSettings(config);
      if (!settings.enabled) return;

      const header = agent.session.header;
      if (header.origin !== 'subagent') return;
      if (header.isSeeded && !settings.applyToFork) return;
      const depth = header.delegationDepth ?? 0;
      if (depth > settings.maxDepth) return;

      const descriptor = readDescriptor(agent.session);
      const label = typeof descriptor.label === 'string' ? descriptor.label : '';
      const member = readMemberName(ctx, agent, header);
      const memberName = member.name;
      // 先登记：即使这一次没有命中规则（继承路由），用户也仍然可能在面板上
      // 点它换模型，所以存活引用必须留下。
      registry.add(agent, {
        memberName,
        label,
        parentSessionId: header.parentSession,
      });
      // 直接子代才问「本对话用什么模型」；更深的层跟着上层走。
      const leadId = depth === 1 ? header.parentSession : header.parentSession;
      const route = resolveRoute(settings, { memberName, label, childId: agent.id, leadId });

      if (route === undefined) {
        appendProbe({ childId: agent.id, depth, memberName, memberReason: member.reason, label, skipped: 'no-rule' });
        // 纯继承 = 用户还没表过态：这是唯一的询问时机。问答是异步的，不挡 spawn。
        const lead = ctx.get('agents')?.get(leadId);
        if (lead !== undefined && !header.isSeeded) {
          try {
            askOnceForSession(ctx, config, lead, agent.id);
          } catch {
            /* 提问失败绝不能影响创建 */
          }
        }
        return;
      }

      const llm = ctx.get('llm');
      let effort;
      try {
        // 换路由前先让适配器整体验证一次：不支持的组合在这里失败，而不是把孩子打死。
        const picked = await pickEffort(llm, route);
        effort = picked.effort;
        appendProbe({
          childId: agent.id,
          route: `${route.provider}/${route.model}`,
          effort: picked.effort ?? null,
          reasoning: picked.reasoning ?? null,
          attempts: picked.attempts,
        });
      } catch (error) {
        appendProbe({
          childId: agent.id,
          depth,
          memberName,
          label,
          resolved: route,
          rejected: error instanceof Error ? error.message : String(error),
          reasoning: error?.reasoning ?? null,
          attempts: error?.attempts ?? null,
        });
        ctx.logger('dsh-model-roster')?.warn?.(
          'model-roster: 路由 %s/%s 不可用，保留继承路由：%s',
          route.provider,
          route.model,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      const installed = installRoute(agent, {
        ...route,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      });
      disposers.set(agent.id, installed.dispose);
      appendProbe({
        childId: agent.id,
        depth,
        memberName,
        label,
        inherited: { provider: descriptor.agentProvider, model: descriptor.agentModel, effort: descriptor.agentReasoningEffort },
        applied: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: effort,
          hit: route.hit,
          optionsPatched: installed.optionsPatched,
        },
      });
    });

    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      registry.remove(agent.id);
      const dispose = disposers.get(agent.id);
      if (dispose !== undefined) {
        dispose();
        disposers.delete(agent.id);
      }
    });

    return () => {
      offCreated();
      offDisposed();
      registry.clear();
      for (const dispose of disposers.values()) dispose();
      disposers.clear();
    };
  });

  /* 设置页的数据面；没有 connection 服务时整块跳过（插件照常工作） */
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const register = connectionCtx.connection.fetch.register;

      const offState = register({
        path: '/api/v1/model-roster/state',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const settings = effectiveSettings(config);
          return json({
            ok: true,
            settings,
            routes: await describeRoutes(connectionCtx),
          });
        },
      });

      const offRules = register({
        path: '/api/v1/model-roster/rules',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400);
          // 字段级合并：**「请求体里有没有这个键」** 才是「要不要改」，不是
          // 「新值是不是 undefined」。否则 `defaultRoute: null`（用户取消勾选）
          // 会被 `??` 当成缺失，旧路由又活回来 —— 设置页怎么点都清不掉。
          const current = effectiveSettings(config);
          const merged = {
            enabled: 'enabled' in body && typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
            rules: 'rules' in body ? normalizeRules(body.rules) : current.rules,
            members: 'members' in body ? normalizeMembers(body.members) : current.members,
            defaultRoute: 'defaultRoute' in body ? (asRoute(body.defaultRoute) ?? null) : (current.defaultRoute ?? null),
            maxDepth: 'maxDepth' in body && Number.isSafeInteger(body.maxDepth) ? body.maxDepth : current.maxDepth,
            applyToFork:
              'applyToFork' in body && typeof body.applyToFork === 'boolean' ? body.applyToFork : current.applyToFork,
          };
          try {
            writeJsonFile(rulesPath(), merged);
          } catch (error) {
            return json({ ok: false, error: `写入失败：${String(error)}` }, 500);
          }
          return json({ ok: true, settings: effectiveSettings(config) });
        },
      });

      const offRecent = register({
        path: '/api/v1/model-roster/recent',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => json({ ok: true, events: readRecentProbes() }),
      });

      /**
       * 创建队友 / 子智能体，并指定它的模型。
       *
       * body: `{ lead, kind: 'teammate'|'subagent', name?, description, prompt,
       *          route: {provider, model, reasoningEffort?} }`
       */
      const offSpawn = register({
        path: '/api/v1/model-roster/spawn',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400);

          const lead = typeof body.lead === 'string' ? body.lead : '';
          const kind = body.kind === 'subagent' ? 'subagent' : 'teammate';
          const description = typeof body.description === 'string' ? body.description.trim() : '';
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          const route = asRoute(body.route);

          if (lead === '') return json({ ok: false, error: '缺少 lead（当前会话 id）' }, 400);
          if (description === '') return json({ ok: false, error: '需要一段任务描述' }, 400);
          if (prompt === '') return json({ ok: false, error: '需要初始任务内容' }, 400);
          if (kind === 'teammate' && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
            return json({ ok: false, error: '队友名必须是小写字母、数字、连字符（lower-kebab-case）' }, 400);
          }
          if (route === undefined) return json({ ok: false, error: '需要选择 provider 和 model' }, 400);

          let effort;
          try {
            const picked = await pickEffort(connectionCtx.get('llm'), route);
            effort = picked.effort;
          } catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
          }

          try {
            const created = await spawnChild(connectionCtx, registry, {
              lead,
              kind,
              name,
              description,
              prompt,
              route,
              reasoningEffort: effort,
              config,
              signal: undefined,
            });
            appendProbe({ action: 'spawn', kind, name: name === '' ? undefined : name, ...created });
            return json({ ok: true, created, members: describeTeam(connectionCtx, registry, lead, effectiveSettings(config)) });
          } catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
          }
        },
      });

      /**
       * 一个 Lead 会话下的成员与子代理，带各自的当前模型。
       * 数据源有两层：存活的 Agent（能立刻改）+ Lead 日志里的历史成员（只能预配置）。
       */
      const offMembers = register({
        path: '/api/v1/model-roster/members',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const url = new URL(request.url ?? 'http://localhost/');
          const leadSessionId = url.searchParams.get('lead') ?? undefined;
          const settings = effectiveSettings(config);
          return json({
            ok: true,
            settings: {
              enabled: settings.enabled,
              members: settings.members,
              sessionRoute: leadSessionId === undefined ? undefined : settings.sessions?.[leadSessionId],
              asked: leadSessionId === undefined ? undefined : settings.asked?.[leadSessionId] !== undefined,
            },
            members: describeTeam(connectionCtx, registry, leadSessionId, settings),
            routes: await describeRoutes(connectionCtx),
          });
        },
      });

      /**
       * 「给这个成员/子代理换模型」。
       *
       * 落盘 + 立刻对存活的那个 Agent 生效（改写 options），所以点是立刻生效的，
       * 不是等下次 spawn。传 `route: null` 表示清掉点名、回到规则/继承。
       */
      const offMemberSet = register({
        path: '/api/v1/model-roster/member',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400);

          const name = typeof body.name === 'string' ? body.name.trim() : '';
          const childId = typeof body.childId === 'string' ? body.childId : '';
          if (name === '' && childId === '') return json({ ok: false, error: '需要 name 或 childId' }, 400);

          const current = effectiveSettings(config);
          const members = { ...current.members };

          // 1) 决定要写进成员表的名字：优先已给的名字，否则从存活登记里反查。
          let targetName = name;
          if (targetName === '' && childId !== '') {
            targetName = registry.get(childId)?.memberName ?? '';
          }

          // 2) 校验路由：不可用的组合就地拒绝，别写进磁盘再让孩子炸。
          const route = body.route === null ? undefined : asRoute(body.route);
          let effort;
          if (route !== undefined) {
            try {
              const picked = await pickEffort(connectionCtx.get('llm'), route);
              effort = picked.effort;
            } catch (error) {
              return json(
                { ok: false, error: error instanceof Error ? error.message : String(error) },
                400,
              );
            }
          }

          // 3) 落盘（点名表）。
          //    键的选择：有名字用名字（队友名跨会话复用）；只有 childId 时用
          //    `#<childId>` —— 子智能体冷恢复后 id 不变，所以点选能跟着它回来。
          const key = targetName !== '' ? targetName : childId !== '' ? `#${childId}` : '';
          if (key !== '') {
            if (route === undefined) delete members[key];
            else members[key] = { ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
            try {
              writeJsonFile(rulesPath(), { ...current, members });
            } catch (error) {
              return json({ ok: false, error: `写入失败：${String(error)}` }, 500);
            }
          }

          // 4) 立刻作用到存活的 Agent 上；没存活的成员靠冷恢复时重跑同一套
          //    agent/created 逻辑，所以「写了盘但没 applied」是**预期**的，
          //    响应里明确标出来让界面提示「下次启动生效」。
          const targets = [];
          if (childId !== '') {
            const entry = registry.get(childId);
            if (entry !== undefined) targets.push(entry);
          } else {
            for (const entry of registry.values()) {
              if (entry.memberName === targetName) targets.push(entry);
            }
          }

          const applied = [];
          for (const entry of targets) {
            if (route === undefined) continue; // 清除点名：等下一次 spawn 走规则/继承，不强行回退存活实例
            const installed = installRoute(entry.agent, {
              ...route,
              ...(effort === undefined ? {} : { reasoningEffort: effort }),
            });
            applied.push({ childId: entry.agent.id, optionsPatched: installed.optionsPatched });
          }

          appendProbe({
            action: 'member-set',
            name: targetName,
            childId: childId === '' ? undefined : childId,
            route: route === undefined ? null : `${route.provider}/${route.model}`,
            effort: effort ?? null,
            appliedTo: applied.length,
          });

          return json({
            ok: true,
            settings: { enabled: current.enabled, members: effectiveSettings(config).members },
            applied,
            members: describeTeam(connectionCtx, registry, typeof body.lead === 'string' ? body.lead : undefined, effectiveSettings(config)),
          });
        },
      });

      /**
       * 批量：把一个 Lead 下的全部队友/子智能体换成同一个路由（或全部恢复继承）。
       *
       * body: `{ lead, route|null, scope?: 'all'|'members'|'subagents' }`
       *
       * 两类目标一起处理：
       * - **存活的 Agent**：改写 `agent.options`，下一步就换；
       * - **已回收的成员**：写点名表（队友用名字、子智能体用 `#childId`），下次唤醒生效。
       */
      const offBulk = register({
        path: '/api/v1/model-roster/bulk',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400);

          const lead = typeof body.lead === 'string' ? body.lead : '';
          if (lead === '') return json({ ok: false, error: '缺少 lead（当前会话 id）' }, 400);
          const scope = body.scope === 'members' || body.scope === 'subagents' ? body.scope : 'all';
          const route = body.route === null ? undefined : asRoute(body.route);
          if (body.route !== null && route === undefined) {
            return json({ ok: false, error: '需要 provider 和 model' }, 400);
          }

          let effort;
          if (route !== undefined) {
            try {
              const picked = await pickEffort(connectionCtx.get('llm'), route);
              effort = picked.effort;
            } catch (error) {
              return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
            }
          }

          const current = effectiveSettings(config);
          const members = { ...current.members };
          const { live, offline } = collectTargets(connectionCtx, registry, lead);

          const keep = (entry) =>
            scope === 'all' ||
            (scope === 'members' && entry.isMember) ||
            (scope === 'subagents' && !entry.isMember);

          let applied = 0;
          let failed = 0;
          for (const entry of live) {
            const isMember = entry.memberName !== undefined;
            if (!keep({ isMember })) continue;
            if (route === undefined) continue; // 恢复继承只对下次启动有意义，不强改存活实例
            try {
              installRoute(entry.agent, {
                ...route,
                ...(effort === undefined ? {} : { reasoningEffort: effort }),
              });
              applied += 1;
            } catch {
              failed += 1;
            }
          }

          let saved = 0;
          for (const entry of offline) {
            if (!keep({ isMember: true })) continue;
            if (route === undefined) {
              if (delete members[entry.name]) saved += 1;
            } else {
              members[entry.name] = { ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
              saved += 1;
            }
          }
          // 存活的子智能体（无名字）按 childId 落盘；存活的队友同时落名字。
          for (const entry of live) {
            const isMember = entry.memberName !== undefined;
            if (!keep({ isMember })) continue;
            const key = isMember ? entry.memberName : `#${entry.agent.id}`;
            if (route === undefined) {
              if (delete members[key]) saved += 1;
            } else {
              members[key] = { ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
              saved += 1;
            }
          }

          try {
            writeJsonFile(rulesPath(), { ...current, members });
          } catch (error) {
            return json({ ok: false, error: `写入失败：${String(error)}` }, 500);
          }

          appendProbe({
            action: 'bulk',
            lead,
            scope,
            route: route === undefined ? null : `${route.provider}/${route.model}`,
            effort: effort ?? null,
            applied,
            saved,
            failed,
          });

          return json({
            ok: true,
            applied,
            saved,
            failed,
            members: describeTeam(connectionCtx, registry, lead, effectiveSettings(config)),
          });
        },
      });

      /**
       * 「本对话默认」：读写按 Lead 会话存的那条路由。
       *
       * body: `{ lead, route|null }`；`route: null` 会连同「已问过」标记一起清掉，
       * 于是这个会话下次派活会重新问一遍。
       */
      const offSession = register({
        path: '/api/v1/model-roster/session',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const body = await readBody(request);
          if (typeof body !== 'object' || body === null) return json({ ok: false, error: '请求体必须是 JSON' }, 400);
          const lead = typeof body.lead === 'string' ? body.lead : '';
          if (lead === '') return json({ ok: false, error: '缺少 lead（当前会话 id）' }, 400);

          const current = readJsonFile(rulesPath()) ?? {};
          const sessions = { ...(current.sessions ?? {}) };
          const asked = { ...(current.asked ?? {}) };

          if (body.route === null) {
            delete sessions[lead];
            delete asked[lead];
          } else {
            const route = asRoute(body.route);
            if (route === undefined) return json({ ok: false, error: '需要 provider 和 model' }, 400);
            let effort;
            try {
              const picked = await pickEffort(connectionCtx.get('llm'), route);
              effort = picked.effort;
            } catch (error) {
              return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
            }
            sessions[lead] = { ...route, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
            asked[lead] = new Date().toISOString();
          }

          try {
            writeJsonFile(rulesPath(), { ...current, sessions, asked });
          } catch (error) {
            return json({ ok: false, error: `写入失败：${String(error)}` }, 500);
          }
          appendProbe({ action: 'session-set', lead, route: body.route === null ? null : `${sessions[lead].provider}/${sessions[lead].model}` });
          return json({
            ok: true,
            sessionRoute: sessions[lead],
            asked: asked[lead] !== undefined,
            members: describeTeam(connectionCtx, registry, lead, effectiveSettings(config)),
          });
        },
      });

      return () => {
        offState();
        offRules();
        offRecent();
        offMembers();
        offMemberSet();
        offSpawn();
        offBulk();
        offSession();
      };
    });
  });
}

