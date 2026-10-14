# CLAUDE AGENT — an agent node with a human branch

This node runs **Claude** as an agent on **this plugin's host**: it reads and
writes files there, runs commands there, and keeps its conversation there. One
run of the node is one *turn* of a session that survives between runs.

It is not an LLM node: a model node sends a prompt and returns a completion,
while this one hands work to an agent that picks its own steps, uses tools, keeps
its session between runs, and can come back with a question. Use it when the task
is *do this in this repo*, not *answer this*.

It holds no credential of its own. A settings profile may carry an Anthropic API
key; when it does not, the agent runs as whatever `claude` on the host is already
logged in as.

## The one idea worth knowing

Claude can stop and ask. When it needs a decision a flow cannot give it, the turn
ends **on purpose**, the node fires its **Needs a human** port, and the question
is written to the run's context. Nothing is held open — no process waiting, no
node sitting at 40% for an afternoon.

Wire that port to a **Human in the Loop** node (park mode) and bring its reply
back into this node:

```
[ Run Claude ] --Answer------------> … the rest of the flow
       |
       '------Needs a human----> [ Human in the Loop ]
                                      (park, key: humanReply)
                                            |
                                            '--> back into [ Run Claude ]
```

When the person closes the task, the flow resumes over the same context, this
node sees its own previous session in the engine's memory, resumes it, hands
Claude the answer, and the conversation continues where it stopped — as many
rounds as the work needs.

The other ports: **Limit reached** (the turn ran out of turns or budget with work
left — run it again to continue), and **Failed**.

## Structured answers

Turn on **Return structured data** and give the node a JSON Schema. Claude's final
answer then conforms to it and lands on the node's output as `output`, so the rest
of the flow reads fields instead of parsing prose:

```jsonc
// Answer schema
{ "type": "object", "required": ["findings"],
  "properties": { "findings": { "type": "array", "items": {
    "type": "object", "properties": {
      "severity": { "type": "string" }, "file": { "type": "string" },
      "summary":  { "type": "string" } } } } } }
```

```
{{$.claudeAgent.output.findings}}      → the array, for a Loop or a Rule node
{{$.claudeAgent.output.findings[0].severity}}
```

`claudeAgent` there is this node's own name in the flow — use whatever the node
is called on your canvas.

## Picking, not typing

Three fields on the form take a *set* of values, and none of them is a set
anyone knows by heart. They are tick-box lists rather than empty rows, and each
carries a button that fetches the real set from this plugin's host:

| Field | Starts as | The button |
|---|---|---|
| **Tools**, **Blocked tools** | the tool names this plugin knows, each with a line saying what it does | **Refresh from host** — the tools the host's own Claude Code advertises, this build's set exactly, MCP tools included |
| **Also readable** | typable rows, because a path has no fixed set | **List directories** — the directories under the connection's workspace root, which is the only tree these may name anyway |

Ticking nothing under **Tools** leaves Claude Code's default set, which is what
most nodes want; the moment one is ticked, the set is exactly what is ticked. A
refresh never unticks anything — a value the host no longer offers stays, marked
as such, rather than being dropped from a node that works.

## What the node commits

| Field | When | What |
|---|---|---|
| `state` | always | `done` · `ask` · `limit` · `error` |
| `sessionId` | always | the Claude session this turn ran as — also the node's job id |
| `text` | always | Claude's own answer for the turn |
| `output` | with a schema | the structured answer |
| `question` | `ask` | `{ prompt, questions[], tool, toolUseId }` — `prompt` is ready to show a person |
| `limit.reason` | `limit` | `max turns` or `budget` |
| `turns`, `costUsd`, `model`, `usage` | always | what the turn spent |

## Check the host

Both of these answer from the agent's own process without sending a single token
to a model, so they cost nothing to run.

The host's Claude, its credential and its default model:

```inflow-meta
claude.meta.ping
```

The models this host offers (also behind the **List models** button on the form):

```inflow-meta
claude.meta.models
```

The tools a run on this host would be offered (also behind the **Refresh from
host** button on the form):

```inflow-meta
claude.meta.tools
```

The sessions already on the host, newest first:

```inflow-meta
claude.meta.sessions
```

## Pointing it at what an upstream node produced

**Workspace** takes `{{$.path}}` tokens like every other free-text field, so the
node can work in a directory the flow only learns at run time — the checkout a
clone node just made, a directory per row of a list:

```
Workspace:  {{$.clone.path}}
```

The token is resolved before the workspace root is checked, so the fence applies
to the resolved path. **Also readable** rows resolve the same way.

A workspace that was named and resolves to *nothing* fails the node. It does not
fall back: an empty Workspace means "the connection's root", and silently handing
the agent a whole root tree instead of the one directory the flow meant is worse
than stopping.

## Running it safely

- **Workspace root** in the settings profile decides where a node may be
  pointed: one outside that tree fails before Claude starts. It is not a sandbox
  — Claude Code takes its project from the git root above the workspace, so its
  read tools can see further. Run the plugin as a user that cannot read what the
  agent must not.
- **Permission mode** decides what the agent may do unasked. `auto` lets a
  classifier judge each tool call and asks a person when it cannot decide;
  `plan` explores without changing anything; `bypassPermissions` approves
  everything, so use it only in a workspace you are willing to lose.
- A turn **stops with its flow**. If a run is stopped, the subprocess is aborted
  — but the conversation is not lost, and the next run resumes it.
