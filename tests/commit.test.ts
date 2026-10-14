// The port contract: every outcome names its branch and then finishes exactly
// once. This is the part a broken plugin gets wrong by hanging a node.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { commit } from "../src/actions/run.js";
import type { Outcome, Stats } from "../src/claude/agent.js";
import { FakePlugin, fakeJob } from "./harness.js";

const stats: Stats = {
  turns: 3,
  costUsd: 0.0123456789,
  durationMs: 1500,
  model: "claude-opus-5-5",
  usage: { "claude-opus-5-5": { inputTokens: 10 } },
  permissionDenials: [],
};

const meta = { workspace: "/srv/ws", previousSessionId: "", answered: false };

async function run(outcome: Outcome) {
  const plugin = new FakePlugin();
  const job = fakeJob(plugin, {});
  await commit(job, outcome, meta);
  return plugin;
}

test("done routes the answer branch and commits the text", async () => {
  const plugin = await run({ kind: "done", sessionId: "s1", text: "all set", stats });
  assert.deepEqual(plugin.commands(), ["next_tags", "done"]);
  assert.equal(plugin.raw("next_tags"), "done");
  const body = plugin.payload("done").details as Record<string, unknown>;
  assert.equal(body.state, "done");
  assert.equal(body.text, "all set");
  assert.equal(body.sessionId, "s1");
  assert.equal(body.costUsd, 0.012346, "cost is rounded, not a float artefact");
});

test("a structured answer is committed as output for downstream paths", async () => {
  const plugin = await run({
    kind: "done",
    sessionId: "s1",
    text: "see output",
    output: { findings: [{ severity: "high", file: "a.go" }] },
    stats,
  });
  const body = plugin.payload("done").details as { output?: { findings: unknown[] } };
  assert.deepEqual(body.output?.findings, [{ severity: "high", file: "a.go" }]);
});

test("ask is a SUCCESSFUL job on the human branch, never an error", async () => {
  const plugin = await run({
    kind: "ask",
    sessionId: "s1",
    text: "",
    question: { toolUseId: "toolu_1", tool: "AskUserQuestion", prompt: "Short or Detailed?", questions: [] },
    stats,
  });
  assert.deepEqual(plugin.commands(), ["next_tags", "done"]);
  assert.equal(plugin.raw("next_tags"), "ask");
  const payload = plugin.payload("done");
  assert.equal(payload.error, undefined, "a parked question is not a failure");
  const body = payload.details as { state: string; question: { prompt: string } };
  assert.equal(body.state, "ask");
  assert.equal(body.question.prompt, "Short or Detailed?");
});

test("a limit routes its own branch so the flow can continue or escalate", async () => {
  const plugin = await run({ kind: "limit", sessionId: "s1", reason: "max turns", text: "partway", stats });
  assert.equal(plugin.raw("next_tags"), "limit");
  const body = plugin.payload("done").details as { limit: { reason: string } };
  assert.equal(body.limit.reason, "max turns");
});

test("a failure routes the exception branch AND reports, keeping the session id", async () => {
  const plugin = await run({ kind: "error", sessionId: "s1", message: "claude could not run", text: "", stats });
  assert.deepEqual(plugin.commands(), ["next_tags", "done"]);
  assert.equal(plugin.raw("next_tags"), "_exception");
  const payload = plugin.payload("done");
  assert.deepEqual(payload.error, { code: 0, message: "claude could not run" });
  const body = payload.details as { sessionId: string; state: string };
  assert.equal(body.sessionId, "s1", "the handle survives a failure, so the work can be picked up");
  assert.equal(body.state, "error");
});

test("the previous session and the answered flag are reported when continuing", async () => {
  const plugin = new FakePlugin();
  await commit(fakeJob(plugin, {}), { kind: "done", sessionId: "s2", text: "", stats }, {
    workspace: "/srv/ws",
    previousSessionId: "s1",
    answered: true,
  });
  const body = plugin.payload("done").details as Record<string, unknown>;
  assert.equal(body.previousSessionId, "s1");
  assert.equal(body.answeredQuestion, true);
});
