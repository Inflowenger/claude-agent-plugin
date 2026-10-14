# Claude Agent — `claude-agent`

A FloMorphic **plugin node** that runs **Claude as an agent on the plugin's own
host**, built on [`@inflowenger/node-plugin-sdk`](https://www.npmjs.com/package/@inflowenger/node-plugin-sdk)
and [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

It appears on the canvas as a **CLAUDE AGENT** node with one action, **Run
Claude**, and four outbound ports. Two things make it different from every other
plugin in this repo:

1. **It holds a conversation, not a request.** Each run of the node is one *turn*
   of a durable Claude Code session. The session id is the inflow **job id**, so
   the engine's own memory of the node's last run (`_registry.jobId`) is the
   handle on that conversation — there is no database, no in-memory map and
   nothing to lose when the plugin restarts.

2. **It can stop and ask.** When Claude needs a decision the flow did not give
   it, the turn ends *on purpose* and the node fires its **Needs a human** port.
   This is the first inflow plugin to declare [outbound ports](#the-ports).

It holds **no credential of its own**: a settings profile may carry an Anthropic
API key, and when it does not, the agent runs as whatever the host's `claude` is
already logged in as.

## The human loop

```
[ Run Claude ] --Answer-----------------> … the rest of the flow
      |      \--Limit reached----------> (run again, or escalate)
      |      \--Failed-----------------> (handle it)
      |
      '---------Needs a human----> [ Human in the Loop ]  (park, key: humanReply)
                                            |
                                            '--> back into [ Run Claude ]
```

What happens on the wire:

| | |
|---|---|
| **run 1** | A fresh session, pinned to this run's job id `A`. Claude works, then calls its question tool. A `PreToolUse` hook answers **`defer`**: the tool does not execute, the process ends with `stop_reason: tool_deferred`, and the pending call stays in the session transcript. The node commits the question and fires `ask`. |
| **between** | The flow parks at a Human in the Loop node. **Nothing is held open** — no process, no connection, no node sitting at 40%. The session file waits on disk (30 days by default). |
| **run 2** | The person's reply is in the context at `$.humanReply`. The engine hands the node `_registry.jobId = A`, so it resumes `A` — forked into this run's job id `B`, which keeps the handle pointing at the live session — and the *same* deferred tool call fires the hook again. This time it answers **`allow`** with the person's words as the tool's result. Claude carries on with its whole context intact. |

As many rounds as the work needs. `scripts/e2e-ask-loop.ts` drives exactly this
against a live Claude, through the real handler, in about half a cent.

Why not simply wait inside the permission callback? Because a flow run is seconds
long and a person is not: the runtime abandons a job that sends no command for its
idle window, and the turn would die with the session. `defer` is the decision
Claude Code provides for precisely this shape, and it is what makes the node's two
halves two runs of one node. The pattern it instantiates is the Node SDK's
[detached-work.md](https://github.com/Inflowenger/node-plugin-sdk/blob/main/docs/detached-work.md)
— a plugin that reports state and ends, with the flow as observer.

## The ports

Declared on the action, so the canvas renders one output port per entry and
stamps its tags on every edge drawn from it. **They are not editable in the
drawer** — a flow author can leave one unwired, but the shape of the branch
belongs to the plugin. An action with ports has no default handle, so every edge
leaving the node must name one.

| Port | Tag | Fires when |
|---|---|---|
| Answer | `done` | The turn finished. `text`, and `output` when a schema was set. |
| Needs a human | `ask` | Claude asked. The session is parked mid-question. A **successful** job — a parked question is not a failure. |
| Limit reached | `limit` | Out of turns or budget with work left. Run the node again to continue. |
| Failed | `_exception` | Claude could not run, or ended in error. Routes *and* reports. |

## Structured answers

Turn on **Return structured data**, give the node a JSON Schema, and Claude's
final answer conforms to it — committed as `output`, so the flow reads fields
instead of parsing prose:

```jsonc
{ "type": "object", "required": ["verdict", "findings"],
  "properties": {
    "verdict":  { "type": "string", "enum": ["pass", "fail"] },
    "findings": { "type": "array", "items": { "type": "object", "properties": {
        "severity": { "type": "string" }, "file": { "type": "string" },
        "line": { "type": "integer" }, "summary": { "type": "string" } } } } } }
```

```
{{$.claudeAgent.output.verdict}}       → "fail"
{{$.claudeAgent.output.findings}}      → the array, for a Loop or a Rule node
{{$.claudeAgent.output.findings[0].file}}
```

`scripts/e2e-structured.ts` runs that review against a deliberately broken file
and prints what a downstream node would read.

## What a run commits

| Field | When | What |
|---|---|---|
| `state` | always | `done` · `ask` · `limit` · `error` |
| `sessionId` | always | the session this turn ran as — also the job id |
| `previousSessionId` | continuing | the session it resumed |
| `text` | always | Claude's own answer for the turn |
| `output` | with a schema | the structured answer |
| `question` | `ask` | `{ prompt, questions[], tool, toolUseId }`; `prompt` is prose, ready for a person |
| `limit.reason` | `limit` | `max turns` or `budget` |
| `answeredQuestion` | after an answer | the turn delivered a person's reply |
| `turns` · `costUsd` · `model` · `usage` · `durationMs` · `workspace` · `observedAt` | always | what the turn did and spent |

## The form

Free-text fields take `{{$.path}}` tokens, resolved from the run's own context
before the prompt is sent (`$this` works too, for a node scoped over a list).

- **Task** — what Claude should do.
- **Where** — *Workspace* (must sit inside the connection's root), *Also readable*
  (typable rows, with a **List directories** button that offers what is under
  the root).
  Both take `{{$.path}}` tokens, resolved before the root is checked, so a node
  can be pointed at what an upstream node produced — `{{$.clone.path}}`. A
  workspace that was named and resolves to nothing fails the node rather than
  falling back to the root, which would hand the agent the whole tree.
- **Model** — *Model* (with a live **List models** button), *Effort*.
- **What it may do** — *Permission mode* (`auto` by default: a classifier judges
  each tool call and a person is asked when it cannot decide), *Tools*,
  *Blocked tools*. The two tool fields are tick-box lists, not empty rows:
  nobody knows the exact names on a first visit. They start from the names this
  plugin knows, each labelled with what it does, and **Refresh from host**
  replaces them with the set the host's own Claude Code advertises — this
  build's tools, MCP ones included. Ticking nothing leaves Claude Code's
  default set; a refresh never unticks a value the host no longer offers, it
  just marks it.
- **How it ends** — *Max turns* (30), *Max spend*, *Session* (`continue` resumes
  the node's own last conversation, which is what makes the human loop work).
- **Structured answer** — *Return structured data*, *Answer schema*.
- **Human in the loop** — *Let Claude ask a person* (on), *Answer path*
  (`$.humanReply`), *Extra instructions*.

## The connection

A settings profile is as much *policy* as credential:

| Field | Meaning |
|---|---|
| `apiKey` | Optional. Empty means the agent runs as the host's own Claude login. |
| `baseUrl` | Optional. A gateway or proxy instead of the public API. |
| `model` | Default model for nodes that name none. |
| `workspaceRoot` | Where nodes may be pointed: a node outside this tree fails before Claude starts. Not a sandbox — see Safety. Empty means unrestricted. |

Keys are matched leniently (case, spaces, dashes, underscores, and the obvious
synonyms), because profiles are typed by hand.

## Meta functions

All three answer from the agent's own process **without sending a token to a
model**, so they are free to run. A transcript-only message (`shouldQuery: false`)
boots the CLI, authenticates it and collects its `init` report; nothing is asked
of the model.

| Method | Purpose |
|---|---|
| `claude.meta.ping` | Connection test — CLI version, which credential is in use, default model, workspace. Also the settings form's `submitTo`, so saving a profile tests it. |
| `claude.meta.models` | The models *this host* offers; re-renders the open form with the model field as a drop-down. |
| `claude.meta.tools` | The tools a run on this host would be offered; re-renders the open form with that set as the tool picker. Serves both *Tools* and *Blocked tools* — the button posts which one it speaks for. |
| `claude.meta.dirs` | The directories under the connection's workspace root; re-renders *Also readable* as a picker of them. |
| `claude.meta.sessions` | The sessions already on the host for that workspace, newest first. |

## Run

```bash
cp .env.inflow.example .env.inflow     # PLUGIN_ID / INFRA_CRED / INFRA_URL
npm install && npm run build && npm start
```

The plugin must already be provisioned in a space — that is where `PLUGIN_ID`,
`INFRA_CRED` and `INFRA_URL` come from. On startup it logs every subject it
subscribed (that line is the confirmation it registered) and then what the host's
Claude actually is — version, default model, credential source — so a
misconfigured host is obvious in the log rather than on the first flow run.

**Requirements on the host:** Node 20+, and Claude Code installed and either
logged in or reachable with an API key. `CLAUDE_EXECUTABLE` points at it when it
is not on `PATH`; `CLAUDE_WORKSPACE_ROOT` is the default fence when no profile
sets one.

## Safety

- **A resolved-to-nothing workspace fails.** An empty Workspace means the
  connection's root, so a `{{$.path}}` token the context cannot answer must not
  quietly become "the whole root tree" — the node fails and names the template.
- **The workspace root fences the NODE, not yet the agent.** Containment is
  checked before Claude starts — a node pointed outside the root fails, and
  traversal and prefix tricks are rejected (`/srv/ws-evil` is not inside
  `/srv/ws`). But `cwd` is not a sandbox: Claude Code resolves its *project* from
  the git root above `cwd`, so its Read/Grep tools can reach files outside the
  workspace — including this plugin's own `.env.inflow`. Verified on a live run.
  Until the sandbox fence lands (see below), treat the root as organisation, not
  containment: run the plugin as a user that cannot read what the agent must not
  see, and keep `.env.inflow` outside any tree the agent works in.
- **`bypassPermissions` approves everything.** Use it only in a workspace you are
  willing to lose. `plan` explores without changing anything.
- **A turn stops with its flow.** The action carries `jobstop`, so a stopped run
  aborts the subprocess instead of leaving an agent writing to someone's disk.
  The conversation is not lost — the transcript is on disk and the next run
  resumes it.
- **No credential reaches a form, a log line or the node's output.** A test walks
  the action's schema and asserts it.

## Develop

```bash
npm test                               # unit tests, no platform, no spend
npx tsx scripts/e2e-ask-loop.ts        # the human loop, live (~$0.005)
npx tsx scripts/e2e-structured.ts      # a structured review, live (~$0.01)
npm run dev                            # run against a platform from source
```

| Path | What |
|---|---|
| [`src/main.ts`](src/main.ts) | wiring: intro, settings, action, metas, signals, start |
| [`src/actions/run.ts`](src/actions/run.ts) | the action: session identity, the answer path, the port contract |
| [`src/actions/ports.ts`](src/actions/ports.ts) | the outbound branches and their tags |
| [`src/actions/forms.ts`](src/actions/forms.ts) | both forms, generated from one declaration each |
| [`src/actions/metas.ts`](src/actions/metas.ts) | the free, token-less helpers |
| [`src/actions/vars.ts`](src/actions/vars.ts) | `{{$.path}}` resolution |
| [`src/claude/agent.ts`](src/claude/agent.ts) | the only module that knows the Agent SDK |
| [`src/claude/ask.ts`](src/claude/ask.ts) | question → prose, reply → tool answer |
| [`src/claude/settings.ts`](src/claude/settings.ts) | profile parsing, the workspace fence, subprocess env |
| [`src/claude/probe.ts`](src/claude/probe.ts) | the zero-token host probe |
