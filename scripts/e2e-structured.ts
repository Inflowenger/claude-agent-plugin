// A structured answer, the way a flow consumes one: Claude reviews a file and
// the node commits typed findings, not prose.
//
//   npx tsx scripts/e2e-structured.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { jobstop } from "@inflowenger/node-plugin-sdk";

import { runAction } from "../src/actions/run.js";
import { ScopedPlugin, fakeJob } from "../tests/harness.js";

const workspace = mkdtempSync(join(tmpdir(), "claude-struct-"));
writeFileSync(
  join(workspace, "login.js"),
  [
    "const { exec } = require('child_process');",
    "// NOTE: token is checked against a value from the request itself",
    "function login(req, res) {",
    "  const q = `SELECT * FROM users WHERE name = '${req.body.name}'`;",
    "  db.query(q, (e, rows) => {",
    "    exec('logger ' + req.body.name);",
    "    if (req.body.token === req.query.token) res.send(rows);",
    "  });",
    "}",
    "module.exports = { login };",
  ].join("\n"),
);

const schema = {
  type: "object",
  required: ["findings", "verdict"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "summary"],
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
        },
      },
    },
  },
};

const plugin = new ScopedPlugin();
const action = runAction(new jobstop.Registry());

await action.requestHandler(
  fakeJob(
    plugin,
    {
      prompt: "Review every file in this workspace for security problems and report them. Do not fix anything.",
      workspace,
      model: "claude-haiku-5-5",
      tools: ["Read", "Glob", "Grep"],
      maxTurns: 8,
      maxBudgetUsd: 0.5,
      askHuman: false,
      session: "new",
      structured: true,
      outputSchema: JSON.stringify(schema),
      settings: { "workspace root": tmpdir() },
    },
    {},
    randomUUID(),
  ),
);

const details = plugin.payload("done").details as Record<string, unknown>;
console.log(`port fired: ${plugin.raw("next_tags")}`);
console.log(`state: ${details.state} · turns ${details.turns} · $${details.costUsd}`);
console.log("output (what a downstream node reads):");
console.log(JSON.stringify(details.output, null, 2));

const out = details.output as { verdict?: string; findings?: unknown[] } | undefined;
const ok = plugin.raw("next_tags") === "done" && typeof out?.verdict === "string" && Array.isArray(out?.findings);
console.log(
  ok
    ? `\nPASS: {{$.claude.output.findings}} is an array of ${out!.findings!.length}, {{$.claude.output.verdict}} = ${out!.verdict}`
    : "\nFAIL: the structured answer did not arrive in the schema's shape",
);
process.exit(ok ? 0 : 1);
