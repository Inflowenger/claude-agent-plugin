// `{{$.path}}` resolution against the flow's context.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readScope, resolveTokens, type ScopeReader } from "../src/actions/vars.js";

const encoder = new TextEncoder();

/** A reader that answers from a map, and records what was asked for. */
function reader(values: Record<string, unknown>): ScopeReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async cmdGetScope(path: string): Promise<Uint8Array> {
      asked.push(path);
      if (!(path in values)) throw new Error("no such path");
      return encoder.encode(JSON.stringify(values[path]));
    },
  };
}

test("a string path is substituted raw, not as quoted JSON", async () => {
  const r = reader({ "$.ticket.body": "disk is full" });
  assert.equal(await resolveTokens("Fix this: {{$.ticket.body}}", r), "Fix this: disk is full");
});

test("a structured path is substituted as compact JSON", async () => {
  const r = reader({ "$.findings": [{ sev: "high" }] });
  assert.equal(await resolveTokens("Review {{ $.findings }}", r), 'Review [{"sev":"high"}]');
});

test("$this resolves like any other root", async () => {
  const r = reader({ "$this.id": 42 });
  assert.equal(await resolveTokens("item {{$this.id}}", r), "item 42");
});

test("each distinct path is read once, however often it appears", async () => {
  const r = reader({ "$.a": "x" });
  assert.equal(await resolveTokens("{{$.a}}/{{$.a}}", r), "x/x");
  assert.deepEqual(r.asked, ["$.a"]);
});

test("an unreadable path leaves the token visible rather than emptying it", async () => {
  const r = reader({});
  assert.equal(await resolveTokens("see {{$.nope}}", r), "see {{$.nope}}");
});

test("text with no tokens never touches the context", async () => {
  const r = reader({});
  assert.equal(await resolveTokens("plain task", r), "plain task");
  assert.deepEqual(r.asked, []);
});

test("readScope parses what the runtime answers, and survives what it cannot", async () => {
  const r = reader({ "$.humanReply": { answers: [{ question: "q", answer: "a" }] } });
  assert.deepEqual(await readScope(r, "$.humanReply"), { answers: [{ question: "q", answer: "a" }] });
  assert.equal(await readScope(r, "$.missing"), undefined);
});
