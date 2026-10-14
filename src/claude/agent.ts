// The driver: one turn of a Claude Code session, reported as an outcome.
//
// Everything the Agent SDK knows is confined to this module, so the action layer
// deals in outcomes ("done", "ask", "limit", "error") rather than in messages,
// hooks and stop reasons. The session identity rules live here too, because they
// are the subtle part:
//
//   * `sessionId` pins a NEW session to an id we chose. We pass the inflow job id,
//     so the engine's own record of the node's last run (`_registry.jobId`) IS the
//     handle on the conversation — no plugin-side state, no database.
//   * `resume` alone would mint a fresh id the engine never sees, orphaning the
//     chain. `resume` + `forkSession` + `sessionId` instead carries the whole
//     history into the id we pinned (the CLI rejects `sessionId` with `resume`
//     unless `forkSession` is set), so every run's handle is the live one.
//   * A pending deferred tool call survives that fork, which is what closes the
//     ask-human loop.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  HookInput,
  HookJSONOutput,
  Options,
  PermissionMode,
  SDKDeferredToolUse,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { answerPayload, readQuestions, renderPrompt, type Question } from "./ask.js";

/** The tool Claude calls when it wants a person. */
export const ASK_TOOL = "AskUserQuestion";

export interface RunParams {
  /** What to send this turn. On a resume this is usually just a nudge. */
  prompt: string;
  /** The id this turn's session is pinned to — the inflow job id. */
  sessionId: string;
  /** The previous run's session id, when this turn continues one. */
  resumeFrom?: string;
  /** The human's words, when this turn exists to answer a deferred question. */
  answer?: string;
  cwd: string;
  /** Extra directories the agent may read, already fenced by the caller. */
  additionalDirectories?: string[];
  env: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** The base set of built-in tools, or undefined for Claude Code's default set. */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  /** Route questions to a person instead of denying them. */
  askHuman: boolean;
  /** JSON Schema the final answer must match; its value lands on `output`. */
  outputSchema?: Record<string, unknown>;
  /** Path to the claude executable, when the host's own build should be used. */
  executable?: string;
  /** Aborts the turn when the flow is stopped. */
  signal?: AbortSignal;
}

export interface Stats {
  turns: number;
  costUsd: number;
  durationMs: number;
  model: string;
  usage: Record<string, unknown>;
  permissionDenials: { tool: string; input?: unknown }[];
}

export type Outcome =
  | { kind: "done"; sessionId: string; text: string; output?: unknown; stats: Stats }
  | { kind: "ask"; sessionId: string; question: Question; text: string; stats: Stats }
  | { kind: "limit"; sessionId: string; reason: string; text: string; stats: Stats }
  | { kind: "error"; sessionId: string; message: string; text: string; stats: Stats };

/** What the canvas is told while the turn runs. */
export type OnStep = (step: { title: string; content: string; turn: number }) => void;

export async function runAgent(params: RunParams, onStep: OnStep = () => {}): Promise<Outcome> {
  const sessionId = params.sessionId;
  let turn = 0;
  let lastResult: SDKResultMessage | undefined;
  // The person's words answer the ONE call that was deferred — the pending call
  // re-fires first on a resume. A further question in the same turn is a new
  // question, and gets parked like any other, rather than being handed an answer
  // that was never meant for it.
  let answerSpent = false;
  const startedAt = Date.now();

  // The ask-human hook. It runs before the permission flow for every
  // AskUserQuestion call, which is what makes it — not `canUseTool` — the right
  // place: `canUseTool` cannot defer, and it cannot wait either.
  const askHook = async (input: HookInput): Promise<HookJSONOutput> => {
    // The matcher already narrows to AskUserQuestion; the guard narrows the type
    // and keeps a future hook event from falling through to the ask path.
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== ASK_TOOL) return {};

    // Resuming with an answer in hand: this is the same call that was deferred
    // last run (same tool_use_id), and the questions come back on the hook input,
    // so nothing had to be carried across the gap.
    if (params.answer && params.answer.trim() !== "" && !answerSpent) {
      answerSpent = true;
      const questions = readQuestions(input.tool_input);
      onStep({ title: "answering", content: firstLine(params.answer), turn });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: answerPayload(questions, params.answer),
        },
      };
    }
    if (!params.askHuman) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "This node runs without a human branch. Decide with the information you have, or finish and say what you could not settle.",
        },
      };
    }
    onStep({ title: "asking a human", content: firstLine(renderPrompt(readQuestions(input.tool_input))), turn });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
        permissionDecisionReason: "handed to a person through the flow; the session resumes with their answer",
      },
    };
  };

  const options: Options = {
    cwd: params.cwd,
    env: params.env,
    settingSources: [],
    systemPrompt: { type: "preset", preset: "claude_code", append: params.appendSystemPrompt },
    hooks: { PreToolUse: [{ matcher: ASK_TOOL, hooks: [askHook] }] },
    // A permission request that the mode cannot settle reaches here. There is no
    // one at a terminal, so it is declined with the one instruction that leads
    // somewhere: ask, and the flow will find a person.
    canUseTool: async (toolName) => ({
      behavior: "deny",
      message: params.askHuman
        ? `No interactive approval is available in a flow run. If you need a person to decide about ${toolName}, call ${ASK_TOOL} — it reaches a human through the workflow. Otherwise take a route that needs no approval.`
        : `No interactive approval is available in a flow run, and this node has no human branch. Take a route that needs no approval, or finish and report that ${toolName} was blocked.`,
    }),
    ...(params.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.effort ? { effort: params.effort } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.allowedTools?.length ? { allowedTools: params.allowedTools } : {}),
    ...(params.disallowedTools?.length ? { disallowedTools: params.disallowedTools } : {}),
    ...(params.maxTurns ? { maxTurns: params.maxTurns } : {}),
    ...(params.maxBudgetUsd ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
    ...(params.outputSchema ? { outputFormat: { type: "json_schema", schema: params.outputSchema } } : {}),
    ...(params.executable ? { pathToClaudeCodeExecutable: params.executable } : {}),
    ...(params.signal ? { abortController: controllerFor(params.signal) } : {}),
    // Pin this turn's id. Continuing a conversation forks it into that id, which
    // keeps the node's memory pointing at the live session (see the file header).
    sessionId,
    ...(params.resumeFrom ? { resume: params.resumeFrom, forkSession: true } : {}),
  };

  try {
    for await (const message of query({ prompt: params.prompt, options })) {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            onStep({
              title: params.resumeFrom ? "session resumed" : "session started",
              content: `${message.model} · ${message.permissionMode} · ${message.tools.length} tools`,
              turn,
            });
          }
          break;
        case "assistant": {
          turn += 1;
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim() !== "") {
              onStep({ title: "thinking out loud", content: firstLine(block.text), turn });
            } else if (block.type === "tool_use") {
              onStep({ title: block.name, content: describeTool(block.input), turn });
            }
          }
          break;
        }
        case "result":
          // A streaming turn can emit more than one result; the last one is the
          // state of the session.
          lastResult = message;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    // `query()` throws after yielding an error result, so a result we already saw
    // is the better report; a throw with no result is a real launch failure.
    if (!lastResult) {
      return {
        kind: "error",
        sessionId,
        message: `claude could not run: ${messageOf(err)}`,
        text: "",
        stats: emptyStats(startedAt, turn),
      };
    }
  }

  if (!lastResult) {
    return {
      kind: "error",
      sessionId,
      message: "claude ended without reporting a result",
      text: "",
      stats: emptyStats(startedAt, turn),
    };
  }

  const stats = statsOf(lastResult, startedAt, turn);
  const text = "result" in lastResult ? String(lastResult.result ?? "") : "";

  // A deferred question: the turn ended on purpose, with a person to find.
  const deferred = deferredOf(lastResult);
  if (lastResult.stop_reason === "tool_deferred" && deferred) {
    const questions = readQuestions(deferred.input);
    return {
      kind: "ask",
      sessionId,
      text,
      question: {
        toolUseId: deferred.id,
        tool: deferred.name,
        prompt: renderPrompt(questions),
        questions,
      },
      stats,
    };
  }
  if (lastResult.stop_reason === "tool_deferred_unavailable") {
    return {
      kind: "error",
      sessionId,
      message:
        "the question Claude was waiting on is no longer answerable in this session; start a fresh session (Session = new) to continue",
      text,
      stats,
    };
  }

  if (lastResult.subtype === "success") {
    return {
      kind: "done",
      sessionId,
      text,
      ...(lastResult.structured_output !== undefined ? { output: lastResult.structured_output } : {}),
      stats,
    };
  }
  if (lastResult.subtype === "error_max_turns" || lastResult.subtype === "error_max_budget_usd") {
    return {
      kind: "limit",
      sessionId,
      reason: lastResult.subtype === "error_max_turns" ? "max turns" : "budget",
      text,
      stats,
    };
  }
  return {
    kind: "error",
    sessionId,
    message: errorsOf(lastResult) || `claude ended as ${lastResult.subtype}`,
    text,
    stats,
  };
}

function controllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/** `deferred_tool_use` rides on the success arm only; a failed turn has none. */
function deferredOf(result: SDKResultMessage): SDKDeferredToolUse | undefined {
  return "deferred_tool_use" in result ? result.deferred_tool_use : undefined;
}

function statsOf(result: SDKResultMessage, startedAt: number, turn: number): Stats {
  const denials =
    "permission_denials" in result && Array.isArray(result.permission_denials)
      ? result.permission_denials.map((d) => ({ tool: d.tool_name, input: d.tool_input }))
      : [];
  return {
    turns: "num_turns" in result ? Number(result.num_turns ?? turn) : turn,
    costUsd: Number(result.total_cost_usd ?? 0),
    durationMs: Date.now() - startedAt,
    model: Object.keys(result.modelUsage ?? {})[0] ?? "",
    usage: (result.modelUsage ?? {}) as Record<string, unknown>,
    permissionDenials: denials,
  };
}

function emptyStats(startedAt: number, turn: number): Stats {
  return { turns: turn, costUsd: 0, durationMs: Date.now() - startedAt, model: "", usage: {}, permissionDenials: [] };
}

function errorsOf(result: SDKResultMessage): string {
  const errs = (result as { errors?: unknown }).errors;
  if (Array.isArray(errs) && errs.length > 0) return errs.map(String).join("; ");
  return "";
}

function describeTool(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return firstLine(v);
  }
  return firstLine(JSON.stringify(o));
}

function firstLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
