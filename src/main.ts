// Command claude-agent is a FloMorphic plugin node that runs Claude as an agent
// on the plugin's own host.
//
// It is unusual among inflow plugins in two ways, and both are the point:
//
//   1. It holds a CONVERSATION, not a request. Each run of the node is one turn
//      of a durable Claude Code session; the session id is the inflow job id, so
//      the engine's own memory of the node's last run (`_registry.jobId`) is the
//      handle on that conversation. No database, no in-memory map, nothing to
//      lose on restart.
//
//   2. It can ASK. When Claude needs a decision a flow cannot give it, the turn
//      ends on purpose and the node fires its "Needs a human" port — the first
//      inflow plugin to declare outbound ports. Wire that port to a Human in the
//      Loop node and bring the reply back: the same session resumes with the
//      answer and carries on, as many times as it takes.
//
// What it does NOT do: hold a credential. A settings profile may carry an API
// key, and when it does not, the agent runs as whatever the host's Claude Code is
// already logged in as. Either way the key never reaches a form, a log line or
// the node's output.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chainSignals,
  jobstop,
  logSignals,
  newPlugin,
  withDotEnv,
  withTimeout,
} from "@inflowenger/node-plugin-sdk";

import { metas } from "./actions/metas.js";
import { runAction } from "./actions/run.js";
import { settingsForm } from "./actions/forms.js";
import { META_PING } from "./actions/forms.js";
import { agentEnv, parseSettings, resolveWorkspace } from "./claude/settings.js";
import { probe } from "./claude/probe.js";

const version = "v0.1.0";

// An agent turn is slow by nature: it reads files, runs commands and thinks. The
// NATS request deadline here covers the plugin's own commands to the runtime
// (progress, context reads, done), not the turn — but a tight default would make
// a busy host look like a broken one, so it is raised well above the SDK's 5s.
// REQ_TIMEOUT on the host overrides it without a rebuild.
const SEND_TIMEOUT_SECONDS = 60;

/**
 * The plugin's page in FloMorphic → Extensions. Authored as Markdown next to this
 * module so the prose lives in a real document; the host turns each fenced
 * ```inflow-meta block into a Run button for that meta method.
 */
function loadManual(): string {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "manual.md"), "utf8");
  } catch (err) {
    console.warn("claude-agent: manual.md not found, serving an empty manual:", err);
    return "";
  }
}

async function main(): Promise<void> {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";
  // The dotenv carries the platform identity only: PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. No Anthropic configuration ever belongs in it.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  // Where the host's claude lives, when it is not on PATH.
  const executable = process.env.CLAUDE_EXECUTABLE?.trim() || undefined;

  // One stop registry for the whole plugin: a turn aborted with its flow stops
  // its subprocess instead of carrying on writing to someone's disk.
  const stops = new jobstop.Registry();
  p.onSignal(chainSignals(logSignals("claude-agent"), stops.onSignal));

  p.intro({
    name: "CLAUDE AGENT",
    author: "FloMorphic",
    version,
    settings: settingsForm().build(),
    manual: loadManual(),
  });

  p.requiredParams(
    settingsForm().settings(async (req) => {
      // The submit handler is a validator, not a store: the platform keeps the
      // profile. Saving one therefore tests it, and costs nothing — the probe
      // boots the agent without sending a single token to a model.
      const ping = metas(executable).find((m) => m.method === META_PING);
      const answer = await ping?.requestHandler(req);
      return (answer as { data?: Record<string, unknown>; error?: unknown }) ?? {
        error: "the connection test is unavailable",
      };
    }),
  );

  const action = runAction(stops, executable);
  p.addAction(action);
  p.addMeta(...metas(executable));

  p.start();

  console.log(`claude-agent plugin ${version} ready: action ${action.method}, ports ${action.outbound?.map((o) => o.tags.join("|")).join(", ")}`);
  await reportHost(executable);

  // start() only wires subscriptions; the process has to stay alive to serve them.
  await new Promise<never>(() => {});
}

/**
 * Say on startup what the agent will actually be — version, model and which
 * credential — so a misconfigured host is obvious in the logs rather than on the
 * first flow run. Best effort: a host without a usable Claude still serves the
 * node's forms, and the node's own error will name the fix.
 */
async function reportHost(executable?: string): Promise<void> {
  const conn = parseSettings({});
  const where = resolveWorkspace(undefined, conn, process.env.CLAUDE_WORKSPACE_ROOT ?? process.cwd());
  if ("error" in where) {
    console.warn("claude-agent: no default workspace on this host:", where.error);
    return;
  }
  try {
    const info = await probe({ cwd: where.cwd, env: agentEnv(conn), executable, withModels: false });
    console.log(
      `claude-agent: Claude Code ${info.version} on this host, default model ${info.model}, credential ${info.apiKeySource}, workspace root ${where.cwd}`,
    );
  } catch (err) {
    console.warn("claude-agent: Claude Code did not start on this host —", err instanceof Error ? err.message : err);
    console.warn("claude-agent: nodes will fail until it is installed and logged in, or a settings profile carries an API key");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
