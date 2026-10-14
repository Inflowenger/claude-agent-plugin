// The whole point of this plugin, proved against a live Claude: one node, two
// runs, one conversation, a person in the middle.
//
// It drives the REAL action handler through a fake Job — no NATS, no platform —
// so what it exercises is the handler's own contract: the ports it fires, the
// session it pins, the question it commits, and the answer it feeds back.
//
// It spends a few cents of whatever credential the host's Claude uses, so it is
// not part of `npm test`:  npx tsx scripts/e2e-ask-loop.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { jobstop } from "@inflowenger/node-plugin-sdk";

import { runAction } from "../src/actions/run.js";
import { ScopedPlugin, fakeJob } from "../tests/harness.js";

const workspace = mkdtempSync(join(tmpdir(), "claude-e2e-"));
writeFileSync(join(workspace, "NOTES.md"), "# Service notes\n\nThe cache is cold on boot.\n");

const action = runAction(new jobstop.Registry());
const body = {
  prompt:
    "Ask me, with your question tool, whether the summary should be a HAIKU or BULLET POINTS. " +
    "Once I answer, read NOTES.md and write the summary in the style I chose. Ask nothing else.",
  workspace,
  model: "claude-haiku-5-5",
  tools: ["Read", "Glob", "Grep"],
  maxTurns: 6,
  maxBudgetUsd: 0.5,
  askHuman: true,
  session: "continue",
  answerFrom: "$.humanReply",
  settings: { "workspace root": tmpdir() },
};

function report(label: string, plugin: ScopedPlugin) {
  const tags = plugin.raw("next_tags");
  const payload = plugin.payload("done");
  const details = payload.details as Record<string, unknown>;
  console.log(`\n[${label}] commands: ${plugin.commands().join(" → ")}`);
  console.log(`[${label}] port fired: ${tags}`);
  console.log(`[${label}] state: ${details.state}  session: ${details.sessionId}  prev: ${details.previousSessionId ?? "-"}`);
  if (payload.error) console.log(`[${label}] error: ${JSON.stringify(payload.error)}`);
  if (details.question) console.log(`[${label}] question:\n${(details.question as { prompt: string }).prompt}`);
  if (details.text) console.log(`[${label}] text: ${String(details.text).slice(0, 400)}`);
  console.log(`[${label}] turns ${details.turns} · $${details.costUsd}`);
  return { tags, details };
}

// ---- Run 1: a fresh session that ends on a question ------------------------
const jobA = randomUUID();
const first = new ScopedPlugin();
await action.requestHandler(fakeJob(first, body, {}, jobA));
const a = report("run 1", first);

if (a.tags !== "ask") {
  console.error(`\nFAIL: expected the "ask" port, got "${a.tags}"`);
  process.exit(1);
}
if (a.details.sessionId !== jobA) {
  console.error(`\nFAIL: the session was not pinned to the job id (${a.details.sessionId} ≠ ${jobA})`);
  process.exit(1);
}

// ---- The flow in between: a Human in the Loop node closes with an answer ---
const second = new ScopedPlugin();
second.answerFor("$.humanReply", {
  status: "closed",
  answers: [{ question: (a.details.question as { questions: { question: string }[] }).questions[0]?.question ?? "style", answer: "Bullet points" }],
  text: "Assistant: haiku or bullets?\nUser: Bullet points",
  closedAt: Math.floor(Date.now() / 1000),
});

// ---- Run 2: the engine hands the node its own last job id ------------------
const jobB = randomUUID();
await action.requestHandler(fakeJob(second, body, { jobId: jobA, doneAt: Math.floor(Date.now() / 1000), conclusion: "done" }, jobB));
const b = report("run 2", second);

const ok =
  b.tags === "done" &&
  b.details.previousSessionId === jobA &&
  b.details.sessionId === jobB &&
  b.details.answeredQuestion === true;

console.log(
  ok
    ? "\nPASS: one node, two runs, one conversation — the question was answered by the flow and Claude carried on."
    : `\nFAIL: run 2 ended as ${JSON.stringify(b.tags)} (${JSON.stringify(b.details.state)})`,
);
process.exit(ok ? 0 : 1);
