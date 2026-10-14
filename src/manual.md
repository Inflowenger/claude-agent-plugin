# CLAUDE — an agent node with a human branch

This node runs **Claude** as an agent on **this plugin's host**: it reads and
writes files there, runs commands there, and keeps its conversation there. One
run of the node is one *turn* of a session that survives between runs.

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
{{$.claude.output.findings}}      → the array, for a Loop or a Rule node
{{$.claude.output.findings[0].severity}}
```

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

The sessions already on the host, newest first:

```inflow-meta
claude.meta.sessions
```

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
