// Profiles are typed by hand, so key matching has to be lenient — and the
// workspace fence has to hold.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentEnv, contains, parseSettings, resolveWorkspace } from "../src/claude/settings.js";

test("settings keys match however they were typed", () => {
  const conn = parseSettings({
    "API Key": "sk-ant-x",
    base_url: "https://gw.example/v1",
    "Default-Model": "claude-opus-5-5",
    "workspace root": "/srv/ws",
  });
  assert.equal(conn.apiKey, "sk-ant-x");
  assert.equal(conn.baseUrl, "https://gw.example/v1");
  assert.equal(conn.model, "claude-opus-5-5");
  assert.equal(conn.workspaceRoot, "/srv/ws");
});

test("a profile from another plugin yields an empty connection, not a crash", () => {
  const conn = parseSettings({ dsn: "postgres://…", schema: "public" });
  assert.equal(conn.apiKey, "");
  assert.equal(conn.workspaceRoot, "");
  assert.deepEqual(parseSettings(undefined), parseSettings({}));
});

test("an empty profile leaves the host's own credential alone", () => {
  const env = agentEnv(parseSettings({}), { PATH: "/usr/bin", ANTHROPIC_API_KEY: "host-key" });
  assert.equal(env.ANTHROPIC_API_KEY, "host-key");
  assert.equal(env.PATH, "/usr/bin", "the subprocess env replaces rather than merges — PATH must survive");
});

test("a profile key overrides the host's", () => {
  const env = agentEnv(parseSettings({ apiKey: "profile-key" }), { ANTHROPIC_API_KEY: "host-key" });
  assert.equal(env.ANTHROPIC_API_KEY, "profile-key");
});

test("containment rejects prefix tricks and traversal", () => {
  assert.ok(contains("/srv/ws", "/srv/ws"));
  assert.ok(contains("/srv/ws", "/srv/ws/a/b"));
  assert.ok(!contains("/srv/ws", "/srv/ws-evil"));
  assert.ok(!contains("/srv/ws", "/srv/ws/../etc"));
});

test("a workspace outside the root fails with the fix, not the symptom", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-ws-"));
  const out = resolveWorkspace("/etc", parseSettings({ workspaceRoot: root }));
  assert.ok("error" in out);
  assert.match(out.error, /outside the allowed root/);
  assert.match(out.error, /widen the root/);
});

test("a workspace inside the root resolves, and the root is the default", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-ws-"));
  const inside = resolveWorkspace(root, parseSettings({ workspaceRoot: root }));
  assert.ok("cwd" in inside && inside.cwd === root);
  const dflt = resolveWorkspace(undefined, parseSettings({ workspaceRoot: root }));
  assert.ok("cwd" in dflt && dflt.cwd === root);
});

test("no workspace and no root names both ways to fix it", () => {
  const out = resolveWorkspace(undefined, parseSettings({}), "");
  assert.ok("error" in out);
  assert.match(out.error, /Workspace on the node/);
  assert.match(out.error, /CLAUDE_WORKSPACE_ROOT/);
});

test("a workspace that does not exist is reported as such", () => {
  const out = resolveWorkspace(join(tmpdir(), "claude-does-not-exist-9fj2"), parseSettings({}), "");
  assert.ok("error" in out);
  assert.match(out.error, /does not exist/);
});
