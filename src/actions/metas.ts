// Meta functions: the synchronous helpers the drawer calls while someone is
// configuring the node. No job, no progress, no flow — and, here, no tokens:
// every one of them answers from the agent's own process rather than from a
// model call, so testing a connection or listing models is free.
//
// A meta call made from a form button arrives FLAT — the form's fields at the
// top level, not wrapped in the action envelope — so `castRequestTo` must not be
// used on one. `decode` below is the tolerant reader that handles both.

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { Meta, Request, Response } from "@inflowenger/node-plugin-sdk";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

import { agentEnv, parseSettings, resolveWorkspace } from "../claude/settings.js";
import { probe } from "../claude/probe.js";
import { META_MODELS, META_PING, META_SESSIONS, runForm, settingsFormBuilder } from "./forms.js";

const decoder = new TextDecoder();

/** Read a meta request whether it arrived flat (a form button) or enveloped. */
function decode(req: Request): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(decoder.decode(req.data));
    if (!raw || typeof raw !== "object") return {};
    const o = raw as Record<string, unknown>;
    const body = o.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return { ...(body as Record<string, unknown>) };
    }
    return o;
  } catch {
    return {};
  }
}

/** The settings profile, from either the flat form or the envelope's `settings`. */
function connOf(call: Record<string, unknown>) {
  const nested = call.settings;
  const raw =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : call;
  return parseSettings(raw);
}

export function metas(executable?: string): Meta[] {
  return [
    {
      // Also the settings form's submitTo, so saving a profile tests it.
      method: META_PING,
      requestHandler: async (req): Promise<Response> => {
        const call = decode(req);
        const conn = connOf(call);
        const where = resolveWorkspace(
          typeof call.workspace === "string" ? call.workspace : undefined,
          conn,
        );
        if ("error" in where) return { error: where.error };

        try {
          const info = await probe({ cwd: where.cwd, env: agentEnv(conn), executable });
          return {
            data: {
              ok: true,
              claudeCodeVersion: info.version,
              defaultModel: conn.model || info.model,
              credential: credentialNote(conn, info.apiKeySource),
              workspace: info.cwd,
              bootMs: info.bootMs,
              models: info.models.length,
            },
          };
        } catch (err) {
          return { error: messageOf(err) };
        }
      },
    },
    {
      // Behind the "List models" button on both forms. Answers with the dialog
      // re-rendered, the model field turned into a drop-down of what this host's
      // Claude actually offers.
      method: META_MODELS,
      requestHandler: async (req): Promise<unknown> => {
        const call = decode(req);
        const conn = connOf(call);
        const where = resolveWorkspace(
          typeof call.workspace === "string" ? call.workspace : undefined,
          conn,
        );
        const cwd = "error" in where ? process.cwd() : where.cwd;

        try {
          const info = await probe({ cwd, env: agentEnv(conn), executable });
          if (info.models.length === 0) {
            return formkit
              .warning("this Claude Code build (%s) does not advertise a model list — type a model id by hand", info.version)
              .patch(null);
          }
          const options = info.models.map((m) => ({ value: m.value, label: m.label }));
          return formkit.choose(
            formFor(call),
            "model",
            options,
            formkit.formData(call),
            formkit.success("%d models on this host", options.length),
          );
        } catch (err) {
          return formkit.failure("cannot reach Claude on this host: %s", messageOf(err)).patch(null);
        }
      },
    },
    {
      // What sessions this workspace already holds — the plugin's own history on
      // this host, for anyone wondering what a node has been doing.
      method: META_SESSIONS,
      requestHandler: async (req): Promise<unknown> => {
        const call = decode(req);
        const conn = connOf(call);
        const where = resolveWorkspace(
          typeof call.workspace === "string" ? call.workspace : undefined,
          conn,
        );
        if ("error" in where) return { error: where.error };
        try {
          const sessions = await listSessions({ dir: where.cwd });
          return sessions.slice(0, 25).map((s) => ({
            sessionId: s.sessionId,
            summary: s.customTitle || s.summary || s.firstPrompt || "",
            lastModified: s.lastModified,
          }));
        } catch (err) {
          return { error: messageOf(err) };
        }
      },
    },
  ];
}

/**
 * Which dialog asked. Both forms carry a `model` field, and `choose` has to
 * rebuild the one that is open — the run drawer is the one with a task on it.
 */
function formFor(call: Record<string, unknown>) {
  const looksLikeRun = "prompt" in call || "permissionMode" in call || "askHuman" in call;
  return looksLikeRun ? runForm() : settingsFormBuilder();
}

/** Say which credential the agent will actually use — the commonest confusion. */
function credentialNote(conn: { apiKey: string }, apiKeySource: string): string {
  if (conn.apiKey) return "the API key in this settings profile";
  if (apiKeySource && apiKeySource !== "none") return `the host's own credential (${apiKeySource})`;
  return "the host's existing Claude login";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
