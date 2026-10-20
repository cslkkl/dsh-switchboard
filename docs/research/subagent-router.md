# @xmoon76/dsh-subagent-router

English | [中文](README.zh.md)

A model-facing DSH plugin that starts a **subagent on a model-selected LLM provider and model**. The model picks the route (`provider`/`model`); the deployment owns the subagent backend (`subagentProvider`, default `spawn`), the default scheduling policy (`backgroundMode`), and the route allowlist (`allowedProviders`). Per-call scheduling is overridable with the optional `run_in_background` parameter, exactly like the official `@deepseek-ai/dsh-tool-subagent` tools. Later turns of a continuable child reuse the official `send_message` / `list_agents` / `interrupt_agent` tools from `@deepseek-ai/dsh-tool-subagent-control`; background one-shot jobs are collected with the official `job_output` / `job_kill` tools from `@deepseek-ai/dsh-tool-jobs`.

## Installation (as a DSH profile bundle)

This package ships as a DSH **profile bundle**: its `cordis.patch.yml`
(`dsh.bundle.patch`) inserts TWO router rows into the profile composition
automatically — `tool-subagent-router` (spawn + continuable, `subagent_route`)
and `tool-subagent-router-fork` (fork + one-shot, `subagent_fork_route`).
Requires a profile whose bundles include `@deepseek-ai/dsh-base` (every
shipped `web`/`headless` template does) — the `subagents` registry and its
`spawn`/`fork` backends come from that base layer.

```sh
dsh plugin --profile <name> add @xmoon76/dsh-subagent-router
```

The command installs the package into the profile and adds it to the profile's
`dsh.profile.bundles` layer list; on the next boot its patch inserts both rows
with the defaults below. To override defaults, patch the same row ids in the
profile's own `cordis.patch.yml` (a patch replaces the row's whole `config`):

```yaml
- id: tool-subagent-router
  config:
    allowedProviders:
      - deepseek-official
```

## Usage walkthrough

The following flow is a practical model-facing invocation. Confirm that the profile has registered the router tools (`subagent_route` / `subagent_fork_route`) and that the selected provider/model route is configured before dispatching.

### Start a continuable child (background by default)

`subagent_route` requires `description` / `prompt` / `provider` / `model`.
The model chooses only the LLM route; deployment configuration still owns the
backend and the default scheduling policy:

```jsonc
{
  "description": "say hi",
  "prompt": "Say hello briefly, then state which model you are using.",
  "provider": "codex",
  "model": "gpt-5.6-luna"
}
// continuable result: started subagent <id>
```

A continuable result acknowledges inbox acceptance and returns a durable id; it
does not contain the child reply. Wait for the DSH settlement notice or inspect
the child transcript by id.

### Wait for a fresh child synchronously

Set `run_in_background: false` when the next action depends on the child's
result. The call then runs the child in the foreground and returns its final
output instead of an id:

```jsonc
{
  "description": "review implementation",
  "prompt": "Review the diff and report concrete risks.",
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "run_in_background": false
}
// foreground result: the child's final output
```

### Continue for more turns

Use the official `send_message` control tool to queue the next FIFO turn after the child has been accepted:

```jsonc
{
  "subagent_id": "<id>",
  "message": "What kinds of engineering tasks are you best at?"
}
// message queued as the next turn for subagent <id>
```

The child keeps its creation-time `provider`/`model` across later turns and cold resume. There is no mid-session route switch.

### Companion controls

Continuation controls are separate from this package and must be mounted from
the official `@deepseek-ai/dsh-tool-subagent-control` plugin; background job
controls come from the official `@deepseek-ai/dsh-tool-jobs` plugin:

| Tool | Purpose |
|---|---|
| `send_message` | Queue the next turn for a durable child (FIFO). |
| `list_agents` | List or recall started children. |
| `interrupt_agent` | Interrupt a running child turn. |
| `job_output` | Collect a background one-shot job's output. |
| `job_kill` | Stop a background one-shot job. |

Official delegation tools (`subagent`, `subagent_fork`) are separate: they are
instances of `@deepseek-ai/dsh-tool-subagent` bound to one fixed deployment
route. This router never replaces them — see [Official tool
coexistence](#official-tool-coexistence) below.

### Start a dynamic fork (one-shot)

`subagent_fork_route` is mounted by the bundle by default (fork + one-shot),
so a forked child that **inherits the parent's completed turns** is available
out of the box. The instance uses a non-conflicting name (never the official
`subagent_fork`):

```yaml
# what the bundle inserts (defaults; override by row id in your profile)
- id: tool-subagent-router-fork
  config:
    subagentProvider: fork
    toolName: subagent_fork_route
    backgroundMode: one-shot
    enableRunInBackground: true
    maxDepth: 3
```

Model call (waits for the result by default):

```jsonc
{
  "description": "review prior design",
  "prompt": "Review the design discussed above and identify correctness or maintainability risks.",
  "provider": "openai",
  "model": "gpt-5.6"
}
// foreground result: the child's final output
```

Fork prompt semantics: the child already sees the parent's **completed turns**,
so the `prompt` only needs to state the new task; the current in-flight parent
turn is **not** part of the fork seed.

### Run a fork in the background

Set `run_in_background: true` to register a background Task and return its job
id immediately:

```jsonc
{
  "description": "deep review",
  "prompt": "Perform a deep review of the design.",
  "provider": "codex",
  "model": "gpt-5.6-luna",
  "run_in_background": true
}
// background result: started background subagent job <id>
```

Collect the result with `job_output` and stop the work with `job_kill`. A
background fork is a one-shot Task, **not** a continuable child: it cannot be
continued with `send_message`.

### Best practices

- Make a fresh-child (`spawn`) `prompt` self-contained: it does not see the parent conversation.
- Make a forked-child (`fork`) `prompt` a delta only: the child inherits the parent's completed turns, so state only the new task; the current in-flight turn is not in the fork seed.
- Verify provider/model availability before dispatch. There is no model-discovery tool, and route errors may surface only when the child's first request resolves the route.
- Treat a continuable start result as an acknowledgement, not as the child answer; use settlement notices and the transcript for the actual result.
- Prefer the background default for independent delegations: start siblings together in one assistant turn and keep working while they run; use `run_in_background: false` only when the next action depends on the result.
- Configure `allowedProviders` when deployment policy restricts routes; do not rely on prompt wording for enforcement.
- Keep credentials, endpoints, and headers out of prompts and tool arguments. Use a unique `toolName` for each loaded instance.
- Remember that `maxTokens` is not durable across activations.

## Why this package

The official `@deepseek-ai/dsh-tool-subagent` binds one instance to one fixed child `agentOptions` (deployment-fixed provider/model). This plugin moves the LLM route choice into the model's hands while keeping every capability owned by the DSH seam: it is a thin Consumer over `ctx.subagents.startContinuable()` / `ctx.subagents.start()` and `ctx.jobs`, and does not re-implement continuation, sessions, persistence, authority, jobs, or queues. Scheduling and lifecycle semantics otherwise mirror the official tools.

## Contract

The model-facing tools `subagent_route` / `subagent_fork_route` take the same parameters:

| Parameter | Required | Meaning |
|---|---|---|
| `description` | yes | Short (3-5 word) label of the delegated task. |
| `prompt` | yes | Complete standalone task (fresh child) or delta over completed turns (forked child). |
| `provider` | yes | Configured DSH LLM provider route for the child. |
| `model` | yes | Model id for the child conversation. |
| `run_in_background` | no | Scheduling override. Continuable instances default to `true` (durable id); one-shot instances default to `false` (final output). Absent when `enableRunInBackground: false`. |

Success returns one of three canonical result kinds, depending on the
instance's `backgroundMode` and the call's `run_in_background`:

| Kind | When | Shape |
|---|---|---|
| `continuable` | continuable mode, background (default) | `{ kind: 'continuable', subagentId }` — durable id, resolved at inbox acceptance |
| `foreground` | any mode with `run_in_background: false` (or one-shot default) | `{ kind: 'foreground', runId, output }` — final child output |
| `background` | one-shot mode with `run_in_background: true` | `{ kind: 'background', jobId }` — collect with `job_output`, stop with `job_kill` |

Credentials, endpoints, headers, `maxTokens`, `outputSchema`, and backend
selection are never exposed to the model.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | `ctx.subagents` provider name. Continuable mode requires `prepareContinuable`; one-shot mode requires a start-capable provider (fork is the supported one-shot backend). |
| `backgroundMode` | `continuable` | Default scheduling policy: `continuable` calls `startContinuable()` and returns a durable subagent id; `one-shot` calls `start()` and returns the run's final output. `run_in_background` overrides it per call. Never model-selectable. |
| `executionMode` | — | **Deprecated** legacy alias for `backgroundMode`. Configured together with `backgroundMode` they must agree, otherwise the plugin fails loud at startup. |
| `enableRunInBackground` | `true` | Whether the model-facing `run_in_background` parameter exists and is honored. `false` removes it from the schema and forces every call to the foreground; a forged `run_in_background: true` is rejected in `execute`. |
| `toolName` | `subagent_route` | Model-facing tool name; distinct per loaded instance. |
| `maxDepth` | `3` | Absolute delegation-depth cap, or `'provider-managed'` for no cap. |
| `persona` | — | Per-child persona shadowing `deployment:persona`. |
| `toolFilter` | — | Per-child global-tool restriction; requires the `toolFilter` capability. |
| `allowedProviders` | — | Deployment-side LLM provider allowlist, enforced in `execute()` before any child work; explicit `[]` denies all. |

## Routing policy

- The model selects only the LLM route: `provider` must name a registered DSH LLM adapter route and `model` a model id on it.
- `allowedProviders` is executor-level enforcement, not a prompt hint. `provider`/`model` validity is ultimately resolved by the DSH LLM/Agent resolution at the child's first request (no `listModels()` hard whitelist, preserving dynamic model routes).
- The subagent backend and the default scheduling policy are deployment configuration; the model never selects them.

## Continuation behavior

- A continuable child is a durable conversation: `send_message` (official control tool) delivers later FIFO turns, `list_agents` lists it, `interrupt_agent` interrupts it — all through `ctx.subagents` authority paths.
- Cold resume keeps the same `agentProvider`/`agentModel`: the durable descriptor persists them, so a resumed Activation still uses the creation-time route.
- `provider`/`model` are fixed at creation; there is no mid-session model switching.
- A background one-shot job is a Task, not a continuable child: `job_output` / `job_kill` (official `@deepseek-ai/dsh-tool-jobs`) are its controls, and `send_message` cannot continue it.

## Official tool coexistence

This plugin **does not replace** the official `subagent` / `subagent_fork`
tools. The bundle mounts BOTH router instances by default, and when the
official tools are present the final tool set is:

```text
subagent            -> official fresh child,  fixed route,   continuable
subagent_route      -> router  fresh child,  dynamic route, continuable
subagent_fork       -> official inherited context, fixed route,   one-shot
subagent_fork_route -> router  inherited context, dynamic route, one-shot
send_message        -> official (@deepseek-ai/dsh-tool-subagent-control)
interrupt_agent     -> official (@deepseek-ai/dsh-tool-subagent-control)
list_agents         -> official (@deepseek-ai/dsh-tool-subagent-control)
job_output          -> official (@deepseek-ai/dsh-tool-jobs)
job_kill            -> official (@deepseek-ai/dsh-tool-jobs)
job_list            -> official (@deepseek-ai/dsh-tool-jobs)
```

The two router tools differ from their official counterparts ONLY in the
child route: the official instances use a deployment-fixed provider/model,
while the router lets the model select `provider`/`model` on every call.
Everything else — scheduling, `run_in_background` semantics, result kinds,
system-prompt guidance — is identical:

| Tool | Child | Route | Lifecycle |
|---|---|---|---|
| `subagent` | fresh | fixed | continuable (`send_message`) |
| `subagent_route` | fresh | **dynamic** | continuable (`send_message`) |
| `subagent_fork` | inherits completed turns | fixed | one-shot (`job_output` / `job_kill`) |
| `subagent_fork_route` | inherits completed turns | **dynamic** | one-shot (`job_output` / `job_kill`) |

The router never shadows, replaces, or mutates official tool definitions: it
registers only its own tool names and leaves every official schema and behavior
intact (locked by the coexistence test suite).

## Support matrix

| Backend | backgroundMode | `run_in_background` omitted / `false` | `run_in_background: true` | Status |
|---|---|---|---|---|
| `spawn` | `continuable` | foreground (waits for output) | durable continuable child | ✅ Recommended |
| `fork` | `one-shot` | foreground (waits for output) | background Task (`job_output` / `job_kill`) | ✅ Recommended |
| `spawn` | `one-shot` | foreground (waits for output) | background Task | ⚪ Compatible |
| `fork` | `continuable` | foreground (waits for output) | durable continuable child | ⚠️ Not recommended |

The router is a generic provider Consumer, so `fork + continuable` is not hard
rejected when a provider exposes `prepareContinuable()` — but the product
documentation recommends `fork + one-shot`.

## Tool name collision rules

- Each loaded router instance needs a **unique** `toolName`. A name already
  registered in the tool registry fails the mount loud, before anything is
  registered.
- DSH official subagent/control names (`subagent`, `subagent_fork`,
  `send_message`, `interrupt_agent`, `list_agents`) get a dedicated diagnostic
  when configured as a router `toolName`.
- Never configure the router's `toolName` as `subagent` or `subagent_fork`.
  The shipped bundle uses `subagent_route` (spawn + continuable) and
  `subagent_fork_route` (fork + one-shot); further instances must pick their
  own unique names.

## Model Experience

### Tool schema

#### What the model sees

The registered router schemas (`subagent_route` / `subagent_fork_route`):
`description`, `prompt`, `provider`, `model` (all required) plus the optional
`run_in_background` override. The `description`/`prompt` wording follows the
backend provider's `inheritsParentContext`: a fresh child is told to provide a
complete standalone prompt; a forked child is told it already sees completed
turns. Continuable instances document the `true` default of
`run_in_background`, the settlement notice, and the explicit foreground
override; one-shot instances document the `false` default and the job id
collected with `job_output` / `job_kill`. No `api_key`, `base_url`,
`max_tokens`, or backend/mode parameters exist.

#### Token effect

Fixed schema cost per request where the tool is visible; no system-prompt
section is contributed by this package except the continuable instances'
`tool:<toolName>` guidance (see below).

#### KV Cache effect

Prefix-stable while the registered tool schema is unchanged; provider registration lifecycle may invalidate reuse from the first changed tool definition.

### System-prompt guidance

A continuable instance with `enableRunInBackground: true` contributes a
`tool:<toolName>` system-prompt section (order 116.5) telling the model to
delegate in the background by default, start independent delegations together
in one assistant message, keep working while they run, and choose
`run_in_background: false` only when the next action depends on the result.
The section renders empty while the tool is absent (provider not yet
registered or already removed), so HMR cannot leave stale guidance. One-shot
instances contribute no section.

### Tool result

#### What the model sees

`started subagent <id>` (continuable), the child's final text (foreground), or
`started background subagent job <id>` (background). Continuable results carry
no child reply; the child's transcript by its id is the source of what it did,
and its settlement notice arrives independently.

#### Token effect

One short result appended per accepted creation (continuable), per job
registration (background), or the child's output (foreground).

#### KV Cache effect

Append-only after the reusable request prefix.

## Known Limitations and Deferred Work

- **No mid-session model switching** — `provider`/`model` are fixed at creation; the durable descriptor persists them, so a resumed Activation still uses the creation-time route.
- **No model discovery tool** — the model must already know the configured provider/model ids; a read-only discovery tool is deferred.
- **A continuable child started in the background cannot be synchronously collected by the initiating tool call** — its settlement arrives through the continuation notice mechanism and its transcript remains available by subagent id; use `run_in_background: false` when the next action depends on the result.
- **`maxTokens` is not durable** — per-activation budgets are not persisted in the DSH continuable descriptor, so the tool does not expose them.
- **Only configured LLM adapters/routes can be used** — the child route must resolve at request time; `provider`/`model` validity may fail only when the child's route is resolved (no `listModels()` hard whitelist by design).
- **Continuation controls require the official control tool** — `send_message` / `list_agents` / `interrupt_agent` come from `@deepseek-ai/dsh-tool-subagent-control`, mounted separately.
- **Background one-shot jobs require the official jobs stack** — `ctx.jobs` (`@deepseek-ai/dsh-jobs` + a registry like `@deepseek-ai/dsh-jobs-local`) and the `job_output` / `job_kill` tools (`@deepseek-ai/dsh-tool-jobs`); a background call without them fails loud.
- **One-shot output is not streamed** — the run's final output is returned once the child settles; intermediate steps stay in the child's transcript.
- **Output schema uses the DSH tools value-schema dialect** — the canonical foreground `output` is `{ type: 'array', items: { type: 'json' } }`, where `'json'` is `@deepseek-ai/dsh-tools`'s Schemastery-based value type (the same dialect the official `tool-subagent` uses), not a bare JSON-Schema keyword; only DSH's tool registry consumes it.

## Development

### Prerequisites

Node.js ≥ 22 and npm. All DSH peer dependencies resolve from the npm registry
(`@deepseek-ai/dsh-*` `0.1.0-rc.x`), so no `deepseek-harness` checkout is
required.

### Gates

```sh
npm run typecheck   # tsc over src + tests
npm run lint        # oxlint
npm run test        # vitest (package integration + Loader composition)
npm run test:coverage  # per-file 100% on src/
npm run build       # tsc emit to lib/
npm pack            # tarball smoke (structure, content, standalone install)
```

