// The action: one run of the node is one turn of a durable Claude session.
//
// The whole design rests on one fact about the platform — the engine hands a
// node back the jobId of its own previous run over the same context
// (`_registry.jobId`), and that is the only state this plugin needs. The job id
// IS the Claude session id (see claude/agent.ts), so:
//
//   run 1   fresh session pinned to job id A · Claude asks · port "Needs a human"
//           ↓  (the flow parks at a Human in the Loop node; nothing is held open)
//   run 2   _registry.jobId = A → resume A into job id B, answer the question,
//           Claude carries on with its full context · port "Answer"
//
// Nothing is stored here, nothing is kept in memory between runs, and a plugin
// restart in the gap changes nothing.

import { castRequestTo, jobstop } from "@inflowenger/node-plugin-sdk";
import type { Action, Job } from "@inflowenger/node-plugin-sdk";
import type { EffortLevel, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { ASK_TOOL, runAgent, type Outcome } from "../claude/agent.js";
import { freshReply } from "../claude/ask.js";
import { agentEnv, parseSettings, resolveWorkspace } from "../claude/settings.js";
import { DEFAULT_ANSWER_PATH, runForm, type RunInput } from "./forms.js";
import { TAG_ASK, TAG_DONE, TAG_EXCEPTION, TAG_LIMIT, runPorts } from "./ports.js";
import { readScope, resolveTokens } from "./vars.js";

export const RUN_METHOD = "claude.agent.run";

const PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
const EFFORTS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);
/** A Claude session id is a UUID; anything else in the registry is not ours. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runAction(stops: jobstop.Registry, executable?: string): Action {
  return {
    method: RUN_METHOD,
    title: "Run Claude",
    description:
      "Give Claude a task to carry out on the plugin's host, in a session that survives between runs. Routes to a human when Claude needs a decision.",
    icon: { icon: "robot-outline" },
    tags: { class: "agent" },
    form: runForm(),
    outbound: runPorts,
    // An agent turn is live work — a subprocess reading and writing files — so it
    // ends when its flow does. The conversation is not lost: the transcript is on
    // disk, and the next run resumes it.
    middleware: [stops.middleware],
    requestHandler: (job: Job) => handleRun(job, executable),
  };
}

async function handleRun(job: Job, executable?: string): Promise<void> {
  const ctx = job.context();
  let input: RunInput;
  let previous = "";
  // When this node's own previous run finished, which is how a reply left at the
  // answer path is told from one that has been sitting there since an earlier
  // round. See freshReply.
  let previousDoneAt = 0;

  try {
    const req = castRequestTo<RunInput>(job.req.data);
    input = req.body ?? {};
    const prev = req._registry?.jobId;
    if (typeof prev === "string" && UUID.test(prev) && prev !== job.jobId) previous = prev;
    const doneAt = Number(req._registry?.doneAt);
    if (Number.isFinite(doneAt) && doneAt > 0) previousDoneAt = doneAt;
  } catch (err) {
    await job.doneWithError(`unreadable request: ${messageOf(err)}`);
    return;
  }

  const conn = parseSettings(input.settings);
  const where = resolveWorkspace(input.workspace, conn);
  if ("error" in where) {
    await fail(job, where.error, { workspace: input.workspace ?? "" });
    return;
  }

  const task = (input.prompt ?? "").trim();
  if (task === "") {
    await fail(job, "no task: write what Claude should do in the node's Task field", {});
    return;
  }

  // Extra readable directories are fenced by the same root as the workspace, or
  // the fence would leak through a field nobody thinks of as a path.
  const extra: string[] = [];
  for (const dir of rows(input.additionalDirectories)) {
    const resolved = resolveWorkspace(dir, conn);
    if ("error" in resolved) {
      await fail(job, `also-readable directory ${dir}: ${resolved.error}`, { workspace: where.cwd });
      return;
    }
    extra.push(resolved.cwd);
  }

  let schema: Record<string, unknown> | undefined;
  if (input.structured === true) {
    const parsed = parseSchema(input.outputSchema);
    if ("error" in parsed) {
      await fail(job, parsed.error, {});
      return;
    }
    schema = parsed.schema;
  }

  const askHuman = input.askHuman !== false;
  const resumeFrom = input.session === "new" ? undefined : previous || undefined;

  // A question parked on the previous run is answered by whatever the flow left
  // at the answer path — the reply key of the Human in the Loop node wired to
  // the "Needs a human" port.
  let answer = "";
  if (resumeFrom && askHuman) {
    const path = (input.answerFrom ?? "").trim() || DEFAULT_ANSWER_PATH;
    answer = freshReply(await readScope(job, path), previousDoneAt);
  }

  const prompt = await resolveTokens(task, job);

  // Progress commands are serialized onto one chain: they must be awaited (an
  // un-awaited command is dropped) but the agent loop cannot wait on the canvas.
  let frames = Promise.resolve();
  let lastFrameAt = 0;
  const maxTurns = positive(input.maxTurns) ?? 30;

  const outcome = await runAgent(
    {
      prompt: answer ? `The person you asked has answered:\n\n${answer}\n\n${prompt}` : prompt,
      sessionId: job.jobId,
      resumeFrom,
      answer,
      cwd: where.cwd,
      additionalDirectories: extra,
      env: agentEnv(conn),
      model: (input.model ?? "").trim() || conn.model || undefined,
      effort: EFFORTS.has(input.effort as EffortLevel) ? (input.effort as EffortLevel) : undefined,
      permissionMode: PERMISSION_MODES.has(input.permissionMode as PermissionMode)
        ? (input.permissionMode as PermissionMode)
        : "auto",
      tools: toolSet(input.tools, askHuman),
      disallowedTools: rows(input.disallowedTools),
      maxTurns,
      maxBudgetUsd: positive(input.maxBudgetUsd),
      appendSystemPrompt: (input.appendSystemPrompt ?? "").trim() || undefined,
      askHuman,
      outputSchema: schema,
      executable,
      signal: ctx.signal,
    },
    (step) => {
      // One frame at a time, and no faster than the canvas can read.
      const now = Date.now();
      if (now - lastFrameAt < 500) return;
      lastFrameAt = now;
      const pct = Math.min(90, 5 + Math.round((step.turn / maxTurns) * 85));
      frames = frames
        .then(() => job.progress(Math.max(5, pct), { title: step.title, content: step.content }))
        .then(() => undefined)
        .catch(() => undefined);
    },
  );

  await frames;

  // The runtime stops answering a job it has concluded, so a turn aborted with
  // its flow must not report. (jobstop cancelled the context; the stop is the
  // conclusion.)
  if (ctx.canceled) return;

  await commit(job, outcome, {
    workspace: where.cwd,
    previousSessionId: resumeFrom ?? "",
    answered: answer !== "",
  });
}

export interface RunMeta {
  workspace: string;
  previousSessionId: string;
  answered: boolean;
}

/**
 * One terminal call per path, with the branch named first.
 *
 * `cmdNextFilter` before the terminal command, in every case including failure:
 * an error in inflow is information, not flow control, so a failed node still
 * routes — down the branch the flow author wired to "Failed".
 */
export async function commit(job: Job, outcome: Outcome, meta: RunMeta): Promise<void> {
  const base = {
    sessionId: outcome.sessionId,
    previousSessionId: meta.previousSessionId || undefined,
    workspace: meta.workspace,
    answeredQuestion: meta.answered || undefined,
    turns: outcome.stats.turns,
    costUsd: round(outcome.stats.costUsd),
    durationMs: outcome.stats.durationMs,
    model: outcome.stats.model || undefined,
    usage: outcome.stats.usage,
    observedAt: Math.floor(Date.now() / 1000),
  };

  switch (outcome.kind) {
    case "done":
      await job.cmdNextFilter([TAG_DONE]);
      await job.done({
        ...base,
        state: "done",
        text: outcome.text,
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      });
      return;

    case "ask":
      // A successful job that says "not yet": the node did look, and the honest
      // answer is that a person has to speak. Failing here would route the error
      // branch for a session that is perfectly healthy.
      await job.cmdNextFilter([TAG_ASK]);
      await job.done({
        ...base,
        state: "ask",
        text: outcome.text,
        question: outcome.question,
      });
      return;

    case "limit":
      await job.cmdNextFilter([TAG_LIMIT]);
      await job.done({
        ...base,
        state: "limit",
        text: outcome.text,
        limit: { reason: outcome.reason },
      });
      return;

    case "error":
      await job.cmdNextFilter([TAG_EXCEPTION]);
      // Partial state is still worth having: the session id is how a human, or a
      // later run, picks the conversation back up.
      await job.doneWithErrorData(outcome.message, {
        ...base,
        state: "error",
        text: outcome.text,
        error: outcome.message,
      });
      return;
  }
}

/** Fail before the agent ever started: no session, nothing to report but the fix. */
async function fail(job: Job, message: string, extra: Record<string, unknown>): Promise<void> {
  await job.cmdNextFilter([TAG_EXCEPTION]);
  await job.doneWithErrorData(message, { state: "error", error: message, ...extra });
}

/**
 * The tool set, with `AskUserQuestion` added whenever the human branch is on.
 *
 * Claude Code drops that tool from a restricted set unless it is named, and
 * without it the model answers its own open questions in prose instead of asking
 * — which is exactly the behaviour the human port exists to replace. An empty
 * list means Claude Code's default set, where the tool is present already.
 */
function toolSet(tools: string[] | undefined, askHuman: boolean): string[] | undefined {
  const named = rows(tools);
  if (named.length === 0) return undefined;
  if (askHuman && !named.includes(ASK_TOOL)) return [...named, ASK_TOOL];
  return named;
}

function parseSchema(text: string | undefined): { schema: Record<string, unknown> } | { error: string } {
  const raw = (text ?? "").trim();
  if (raw === "") {
    return { error: "structured answer is on but the answer schema is empty: write a JSON Schema, or turn it off" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `the answer schema is not valid JSON: ${messageOf(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "the answer schema must be a JSON Schema object, e.g. {\"type\":\"object\",\"properties\":{…}}" };
  }
  return { schema: parsed as Record<string, unknown> };
}

function rows(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => v !== "");
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
