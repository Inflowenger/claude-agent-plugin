// The node's two forms, generated from one declaration each.
//
// Hand-writing a JSON Schema beside a UI Schema drifts: rename a property in one
// and the field silently stops rendering in the other. formkit generates both
// documents from the field list, in the order written, so there is one place to
// change.
//
// Nothing here may describe a credential: the connection is the platform's half
// of the call and arrives as `body.settings`. A test asserts that.

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { FormBuilder } from "@inflowenger/node-plugin-sdk";

export const META_PING = "claude.meta.ping";
export const META_MODELS = "claude.meta.models";
export const META_SESSIONS = "claude.meta.sessions";

/** The default place a Human in the Loop node leaves its reply. */
export const DEFAULT_ANSWER_PATH = "$.humanReply";

/**
 * The connection form. A profile is a *policy* here as much as a credential: the
 * workspace root is the fence the agent's file and shell tools work inside.
 */
export function settingsForm(): formkit.Form {
  return formkit
    .form("Claude agent")
    .describe(
      "How this plugin's host runs Claude. Leave the key empty to use the Claude login that already exists on that host.",
    )
    .submitTo(META_PING)
    .group(
      "Credential",
      formkit
        .secret("apiKey", "Anthropic API key")
        .describe(
          "Optional. When empty, the agent runs as whatever the host's Claude Code is logged in as — a subscription login or an ambient ANTHROPIC_API_KEY.",
        ),
      formkit
        .text("baseUrl", "API base URL")
        .describe("Optional. Point the agent at a gateway or proxy instead of the public API."),
    )
    .group(
      "Defaults",
      formkit
        .text("model", "Default model")
        .describe("Optional. Used by every node that does not name its own model.")
        .lookup(META_MODELS, "List models"),
      formkit
        .text("workspaceRoot", "Workspace root")
        .describe(
          "The one directory tree nodes on this connection may work in. A node pointed outside it fails before Claude starts. Leave empty to let each node name any directory on the host.",
        ),
    );
}

export function settingsFormBuilder(): FormBuilder {
  return settingsForm().build();
}

/**
 * The run action's form.
 *
 * It is long because an agent has genuinely many dials, so it is grouped: what
 * to do, where, which model, what it may touch, how it ends, and how a question
 * reaches a person. Every field has a default that works.
 */
export function runForm(): FormBuilder {
  return formkit
    .form("Run Claude")
    .describe(
      "Give Claude a task to carry out on this plugin's host. The session survives between runs, so a question it asks can be answered by a person and the same conversation continues.",
    )
    .add(
      formkit
        .textArea("prompt", "Task")
        .required()
        .describe(
          "What Claude should do. `{{$.path}}` tokens are replaced from the run's context first — `{{$this.ticket.body}}`, `{{$.findings}}`.",
        ),
    )
    .group(
      "Where",
      formkit
        .text("workspace", "Workspace")
        .describe(
          "The directory on the plugin's host Claude works in. Must sit inside the connection's workspace root. Defaults to that root.",
        ),
      formkit
        .list("additionalDirectories", "Also readable")
        .describe("Optional extra directories the agent may read, one per row."),
    )
    .group(
      "Model",
      formkit.text("model", "Model").describe("Optional override of the connection's default.").lookup(META_MODELS, "List models"),
      formkit
        .enumOf("effort", "Effort", "", "low", "medium", "high", "xhigh", "max")
        .describe("How hard the model works before answering. Empty leaves the model's own default."),
    )
    .group(
      "What it may do",
      formkit
        .enumOf("permissionMode", "Permission mode", "auto", "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions")
        .default("auto")
        .describe(
          "`auto` lets a classifier decide each tool call and asks a human when it cannot. `plan` explores without changing anything. `bypassPermissions` approves everything — use it only in a workspace you are willing to lose.",
        ),
      formkit
        .list("tools", "Tools")
        .describe(
          "The built-in tools Claude may use, one per row (Read, Glob, Grep, Edit, Write, Bash, WebSearch…). Empty means Claude Code's default set. AskUserQuestion is added for you whenever the human branch is on.",
        ),
      formkit
        .list("disallowedTools", "Blocked tools")
        .describe("Tools to withhold even when they are in the default set."),
    )
    .group(
      "How it ends",
      formkit.integer("maxTurns", "Max turns").default(30).min(1).describe("Tool-use round trips before the turn gives up and routes Limit reached."),
      formkit
        .number("maxBudgetUsd", "Max spend (USD)")
        .min(0)
        .describe("Optional ceiling for this turn. Reaching it routes Limit reached rather than failing."),
      formkit
        .enumOf("session", "Session", "continue", "new")
        .default("continue")
        .describe(
          "`continue` resumes the conversation this node had on its last run over the same context — which is what makes the human loop work. `new` starts fresh every run.",
        ),
    )
    .group(
      "Structured answer",
      formkit
        .bool("structured", "Return structured data")
        .default(false)
        .describe(
          "Make Claude's final answer conform to a JSON Schema. The value lands on the node's output as `output`, so downstream nodes can read fields out of it — `{{$.claude.output.findings}}` — instead of parsing prose.",
        ),
      formkit
        .textArea("outputSchema", "Answer schema (JSON Schema)")
        .showWhen("structured", true)
        .describe(
          'The shape of the answer. Example: {"type":"object","required":["findings"],"properties":{"findings":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string"},"file":{"type":"string"},"summary":{"type":"string"}}}}}}',
        ),
    )
    .group(
      "Human in the loop",
      formkit
        .bool("askHuman", "Let Claude ask a person")
        .default(true)
        .describe(
          "When Claude needs a decision it cannot make, park the session and fire the Needs a human port. Off means it is told to decide alone.",
        ),
      formkit
        .text("answerFrom", "Answer path")
        .default(DEFAULT_ANSWER_PATH)
        .showWhen("askHuman", true)
        .describe(
          "Where in the run's context the person's reply lands — the result key of the Human in the Loop node you wired to Needs a human.",
        ),
      formkit
        .textArea("appendSystemPrompt", "Extra instructions")
        .describe("Optional text appended to Claude Code's system prompt for this node — house rules, tone, what never to touch."),
    )
    .build();
}

/** The shape `runForm` delivers as `body`. */
export interface RunInput {
  prompt?: string;
  workspace?: string;
  additionalDirectories?: string[];
  model?: string;
  effort?: string;
  permissionMode?: string;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  session?: string;
  structured?: boolean;
  outputSchema?: string;
  askHuman?: boolean;
  answerFrom?: string;
  appendSystemPrompt?: string;
  /** The platform's half of the body: the resolved settings profile. */
  settings?: Record<string, unknown>;
}
