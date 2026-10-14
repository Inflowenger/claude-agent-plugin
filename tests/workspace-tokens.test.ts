// The workspace is a path an upstream node produced, so it carries `{{$.path}}`
// tokens like every other free-text field. These drive the real run action and
// stop at the fence, which is before Claude would be started — so they prove the
// resolution without spending anything.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { jobstop } from "@inflowenger/node-plugin-sdk";

import { runAction } from "../src/actions/run.js";
import { ScopedPlugin, fakeJob } from "./harness.js";

const root = mkdtempSync(join(tmpdir(), "claude-ws-"));
const settings = { workspaceRoot: root };

/** Drive the run action over a context that answers the paths it is given. */
async function run(body: Record<string, unknown>, scope: Record<string, unknown> = {}) {
  const plugin = new ScopedPlugin();
  for (const [path, value] of Object.entries(scope)) plugin.answerFor(path, value);
  const job = fakeJob(plugin, { settings, ...body });
  await runAction(new jobstop.Registry()).requestHandler(job);
  return plugin;
}

/** The message of the terminal error, however the SDK wraps it. */
function errorOf(plugin: ScopedPlugin): string {
  const raw = plugin.payload("done").error as { message?: string } | string;
  return typeof raw === "string" ? raw : (raw?.message ?? "");
}

test("a workspace token is resolved before the fence is checked", async () => {
  // It resolves to a path outside the root, so the fence refuses it — and names
  // the RESOLVED path, which is only possible if the token was substituted first.
  const plugin = await run(
    { prompt: "review it", workspace: "{{$.clone.path}}" },
    { "$.clone.path": "/elsewhere/repo" },
  );
  assert.match(errorOf(plugin), /\/elsewhere\/repo is outside the allowed root/);
  const details = plugin.payload("done").details as { workspace?: string };
  assert.equal(details.workspace, "/elsewhere/repo", "the node reports what it resolved, not the template");
});

test("a workspace that resolves to nothing fails instead of falling back to the root", async () => {
  // The dangerous case: an empty workspace means "the connection's root", so a
  // token the context cannot answer would otherwise hand the agent the whole
  // tree. It must fail, naming the template that came back empty.
  const plugin = await run({ prompt: "review it", workspace: "{{$.clone.path}}" });
  assert.match(errorOf(plugin), /\{\{\$\.clone\.path\}\} resolved to nothing/);
  assert.equal(plugin.commands().includes("next_tags"), true, "a failure still routes the Failed port");
});

test("an also-readable row that resolves to nothing fails too", async () => {
  const plugin = await run({ prompt: "review it", workspace: root, additionalDirectories: ["{{$.nope}}"] });
  assert.match(errorOf(plugin), /also-readable directory \{\{\$\.nope\}\} resolved to nothing/);
});

test("an also-readable directory is resolved the same way", async () => {
  const plugin = await run(
    { prompt: "review it", workspace: root, additionalDirectories: ["{{$.docs.dir}}"] },
    { "$.docs.dir": "/outside/docs" },
  );
  assert.match(errorOf(plugin), /also-readable directory \/outside\/docs/);
});
