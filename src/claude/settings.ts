// The connection half of the node: what a settings profile carries, and how a
// workspace path is resolved against it.
//
// This plugin runs an agent *on its own host*, which makes it unusual among
// inflow plugins: the thing a profile fences off is not an API endpoint but a
// directory on disk and the credential the agent runs as. Everything here is
// pure — no SDK import, no Claude import — so it is testable without a platform.

import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { statSync } from "node:fs";

/** A resolved connection: the profile's values, after lenient key matching. */
export interface Conn {
  /** Anthropic API key. Empty means "use whatever the host's Claude is logged in as". */
  apiKey: string;
  /** Alternate API base URL (gateway, proxy, Bedrock/Vertex front). */
  baseUrl: string;
  /** Default model for every action that does not name one. */
  model: string;
  /**
   * The one directory tree the agent may be pointed at. Empty means unfenced —
   * the action's own workspace field is then used verbatim, which is a
   * deliberate operator choice, not an oversight.
   */
  workspaceRoot: string;
}

/**
 * Settings profiles are often typed by hand as key/value rows, so match keys
 * leniently: ignore case, spaces, dashes, underscores and dots, and accept the
 * obvious synonyms. One parser, every action routed through it.
 */
export function parseSettings(raw: Record<string, unknown> | undefined | null): Conn {
  const flat = new Map<string, string>();
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === null || v === undefined) continue;
    const key = k.toLowerCase().replace(/[\s._-]/g, "");
    const val = typeof v === "string" ? v.trim() : String(v);
    if (val !== "") flat.set(key, val);
  }
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const hit = flat.get(n);
      if (hit) return hit;
    }
    return "";
  };
  return {
    apiKey: pick("apikey", "anthropicapikey", "token", "apitoken", "key", "secret"),
    baseUrl: pick("baseurl", "anthropicbaseurl", "url", "endpoint", "gateway", "host"),
    model: pick("model", "defaultmodel", "anthropicmodel"),
    workspaceRoot: pick("workspaceroot", "workspace", "root", "rootdir", "basedir", "dir", "cwd"),
  };
}

/**
 * The environment the Claude Code subprocess runs with.
 *
 * The Agent SDK REPLACES the subprocess environment when `env` is set rather
 * than merging it, so the parent's PATH/HOME must be spread back in or the
 * subprocess cannot even find its own binary. A profile that carries no key
 * leaves ANTHROPIC_API_KEY untouched, which is what lets the host's existing
 * Claude login serve the node.
 */
export function agentEnv(conn: Conn, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  if (conn.apiKey) env.ANTHROPIC_API_KEY = conn.apiKey;
  if (conn.baseUrl) env.ANTHROPIC_BASE_URL = conn.baseUrl;
  // The plugin is a long-running service: never let the agent try to open a
  // browser or a pager on a headless host.
  env.CI = env.CI ?? "1";
  return env;
}

/** Expand a leading `~` and make the path absolute. */
function expand(p: string): string {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return resolve(homedir(), t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(t);
}

/** True when `child` is `root` or sits inside it (no `..` escapes, no prefix tricks). */
export function contains(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Where this run's agent works.
 *
 * Errors name the fix rather than the symptom, because they are rendered on the
 * node for whoever is building the flow — not for whoever deployed the plugin.
 */
export function resolveWorkspace(
  requested: string | undefined,
  conn: Conn,
  fallbackRoot = process.env.CLAUDE_WORKSPACE_ROOT ?? "",
): { cwd: string } | { error: string } {
  const root = conn.workspaceRoot || fallbackRoot;
  const want = (requested ?? "").trim();

  if (!want && !root) {
    return {
      error:
        "no workspace: set Workspace on the node, or a workspace root in the settings profile (or CLAUDE_WORKSPACE_ROOT on the plugin's host)",
    };
  }
  const cwd = want ? expand(want) : resolve(expand(root));

  if (root && !contains(expand(root), cwd)) {
    return {
      error: `workspace ${cwd} is outside the allowed root ${expand(root)}: point the node inside that tree, or widen the root in the settings profile`,
    };
  }
  try {
    if (!statSync(cwd).isDirectory()) return { error: `workspace ${cwd} is not a directory` };
  } catch {
    return { error: `workspace ${cwd} does not exist on the plugin's host (${hostName()})` };
  }
  return { cwd };
}

function hostName(): string {
  return process.env.HOSTNAME || process.env.HOST || "this host";
}
