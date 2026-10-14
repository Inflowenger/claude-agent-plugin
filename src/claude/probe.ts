// A connection test that spends nothing.
//
// The honest way to test this node's "connection" is to start the agent the way
// an action would and see what it reports about itself. The trick is to do it
// without a model call: a streaming-input prompt whose only message carries
// `shouldQuery: false` is appended to the transcript and never sent to the
// model, so the CLI boots, authenticates, loads its tools and answers the
// `init` message — and the turn costs nothing. With the process up, its own
// control requests answer the rest (the live model list).

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKSystemMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface Probe {
  version: string;
  model: string;
  /** Where the agent's credential came from, as Claude Code sees it. */
  apiKeySource: string;
  cwd: string;
  tools: string[];
  models: { value: string; label: string }[];
  /** Milliseconds from spawn to the init message — a useful smoke number. */
  bootMs: number;
}

const BOOT_TIMEOUT_MS = 30_000;

export async function probe(opts: {
  cwd: string;
  env: Record<string, string>;
  executable?: string;
  withModels?: boolean;
}): Promise<Probe> {
  const startedAt = Date.now();
  const idle = new AbortController();

  // One transcript-only message, then hold the stream open: `query()` ends as
  // soon as the input iterator finishes, and the control requests need it alive.
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: "connection test (not sent to the model)" },
      parent_tool_use_id: null,
      shouldQuery: false,
    };
    await new Promise<void>((resolve) => {
      if (idle.signal.aborted) return resolve();
      idle.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();

  const q: Query = query({
    prompt,
    options: {
      cwd: opts.cwd,
      env: opts.env,
      settingSources: [],
      tools: [],
      // Nothing here should be remembered: this session is a smoke test.
      persistSession: false,
      ...(opts.executable ? { pathToClaudeCodeExecutable: opts.executable } : {}),
    },
  });

  try {
    const init = await firstInit(q, BOOT_TIMEOUT_MS);
    const models = opts.withModels === false ? [] : await modelList(q);
    return {
      version: init.claude_code_version,
      model: init.model,
      apiKeySource: String(init.apiKeySource),
      cwd: init.cwd,
      tools: init.tools,
      models,
      bootMs: Date.now() - startedAt,
    };
  } finally {
    // Let the generator finish, then close the query so no CLI process is left
    // behind on a host that may serve hundreds of these.
    idle.abort();
    try {
      await q.return(undefined);
    } catch {
      /* the process is already gone */
    }
  }
}

async function firstInit(q: Query, timeoutMs: number): Promise<SDKSystemMessage> {
  const deadline = Date.now() + timeoutMs;
  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") return message;
    if (Date.now() > deadline) break;
  }
  throw new Error(
    `claude did not start within ${Math.round(timeoutMs / 1000)}s — check that the CLI is installed on the plugin's host and that it is logged in (or give the settings profile an API key)`,
  );
}

async function modelList(q: Query): Promise<{ value: string; label: string }[]> {
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({ value: m.value, label: m.displayName }));
  } catch {
    // An older CLI may not advertise the control request. The model field is free
    // text anyway, so an empty list costs the user nothing but the convenience.
    return [];
  }
}
