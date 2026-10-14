// Meta functions: the synchronous helpers the drawer calls while someone is
// configuring the node. No job, no progress, no flow — and, here, no tokens:
// every one of them answers from the agent's own process rather than from a
// model call, so testing a connection or listing models is free.
//
// A meta call made from a form button arrives FLAT — the form's fields at the
// top level, not wrapped in the action envelope — so `castRequestTo` must not be
// used on one. `decode` below is the tolerant reader that handles both.

import { relative } from "node:path";

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { Meta, Request, Response } from "@inflowenger/node-plugin-sdk";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

import { agentEnv, parseSettings, resolveWorkspace } from "../claude/settings.js";
import { listDirs } from "../claude/dirs.js";
import { probe } from "../claude/probe.js";
import { toolOptions } from "../claude/tools.js";
import {
  META_DIRS,
  META_MODELS,
  META_PING,
  META_SESSIONS,
  META_TOOLS,
  runForm,
  settingsFormBuilder,
} from "./forms.js";
import { chooseMany, rowsOf, targetOf, withCurrent, type Option } from "./pick.js";

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

/** The workspace the open form names, if it names one. */
function workspaceOf(call: Record<string, unknown>): string | undefined {
  return typeof call.workspace === "string" ? call.workspace : undefined;
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
        const where = resolveWorkspace(workspaceOf(call), conn);
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
        const where = resolveWorkspace(workspaceOf(call), conn);
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
      // Behind the "Refresh from host" button on both tool fields, which post
      // their own name as `targetField` — one handler fills either of them.
      //
      // A tool list cannot be typed from memory, so the field ships with the
      // names this plugin knows and this button replaces them with the set the
      // host's own Claude Code advertises: the same set a run of the node would
      // be offered, MCP tools and build differences included.
      method: META_TOOLS,
      requestHandler: async (req): Promise<unknown> => {
        const call = decode(req);
        const conn = connOf(call);
        const where = resolveWorkspace(workspaceOf(call), conn);
        const cwd = "error" in where ? process.cwd() : where.cwd;

        let options: Option[];
        let note: formkit.Notification;
        try {
          const info = await probe({
            cwd,
            env: agentEnv(conn),
            executable,
            withModels: false,
            withTools: true,
          });
          options = toolOptions(info.tools);
          note = formkit.success("%d tools on this host (Claude Code %s)", options.length, info.version);
        } catch (err) {
          // The catalogue is still better than an empty picker, so this is a
          // warning rather than a failure: the list below is just not the
          // host's own.
          options = toolOptions([]);
          note = formkit.warning(
            "cannot reach Claude on this host (%s) — offering the names this plugin knows instead",
            messageOf(err),
          );
        }

        // Run from the plugin's manual rather than from the form: there is no
        // dialog to rebuild, so answer with the list itself.
        if (!looksLikeRun(call)) return options;

        const target = targetOf(call, "tools");
        return chooseMany(
          runForm(),
          target,
          withCurrent(options, rowsOf(call[target])),
          formkit.formData(call),
          note,
        );
      },
    },
    {
      // Behind "List directories" on the "Also readable" field. Paths have no
      // closed set, so this field stays typable and only becomes a picker once
      // someone asks what is there.
      method: META_DIRS,
      requestHandler: async (req): Promise<unknown> => {
        const call = decode(req);
        const conn = connOf(call);
        // The fence the field is bounded by is the connection's root; without
        // one, the node's own workspace is as far as a guess can go.
        const root = resolveWorkspace(conn.workspaceRoot ? undefined : workspaceOf(call), conn);
        if ("error" in root) return formkit.failure("%s", root.error).patch(null);

        const scan = listDirs(root.cwd);
        const options: Option[] = scan.dirs.map((dir) => ({
          value: dir,
          label: relative(root.cwd, dir),
        }));

        if (!looksLikeRun(call)) {
          return { root: root.cwd, directories: scan.dirs, truncated: scan.truncated };
        }
        if (options.length === 0) {
          // Rebuilding the field with no choices would take away the one thing
          // that still works: typing a path.
          return formkit
            .warning("nothing under %s to offer — type the path instead", root.cwd)
            .patch(null);
        }

        const target = targetOf(call, "additionalDirectories");
        return chooseMany(
          runForm(),
          target,
          withCurrent(options, rowsOf(call[target])),
          formkit.formData(call),
          formkit.success(
            "%d directories under %s%s",
            options.length,
            root.cwd,
            scan.truncated ? " (the nearest ones — the tree is large)" : "",
          ),
        );
      },
    },
    {
      // What sessions this workspace already holds — the plugin's own history on
      // this host, for anyone wondering what a node has been doing.
      method: META_SESSIONS,
      requestHandler: async (req): Promise<unknown> => {
        const call = decode(req);
        const conn = connOf(call);
        const where = resolveWorkspace(workspaceOf(call), conn);
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
 * Did this come from the run drawer? Both forms carry a `model` field, and a
 * rebuilt form has to be the one that is actually open — the run drawer is the
 * one with a task on it. A call with none of these markers came from the
 * plugin's manual page, where there is no dialog to rebuild at all.
 */
function looksLikeRun(call: Record<string, unknown>): boolean {
  return "prompt" in call || "permissionMode" in call || "askHuman" in call;
}

/** The form a lookup on either dialog has to rebuild. */
function formFor(call: Record<string, unknown>) {
  return looksLikeRun(call) ? runForm() : settingsFormBuilder();
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
