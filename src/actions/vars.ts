// `{{$.path}}` in a free-text field, resolved from the run's own context.
//
// A prompt is only useful if it can carry what the flow already knows — the
// ticket, the diff, the findings an upstream node produced. The flow's context is
// readable by JSON path from inside a job, so any `{{ ... }}` holding a path is
// substituted before the prompt is sent. `$this` works too: it is inflow's root
// for the location this run was handed, which is what a node scoped over a list
// stands on.

/** Anything that can read the flow's context by path. */
export interface ScopeReader {
  cmdGetScope(jsonPath: string): Promise<Uint8Array>;
}

const TOKEN = /\{\{\s*(\$[^{}]*?)\s*\}\}/g;
const decoder = new TextDecoder();

/**
 * Replace every `{{$...}}` token with what the context holds at that path.
 *
 * A path that resolves to a string is substituted raw — a prompt wants the text,
 * not a quoted JSON string. Anything else is substituted as compact JSON. A path
 * that cannot be read leaves the token in place rather than silently emptying it,
 * so a typo is visible in the prompt the node reports instead of becoming a
 * blank instruction.
 */
export async function resolveTokens(text: string, job: ScopeReader): Promise<string> {
  const paths = [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];
  if (paths.length === 0) return text;

  const values = new Map<string, string>();
  for (const path of paths) {
    try {
      values.set(path, render(await job.cmdGetScope(path)));
    } catch {
      /* leave the token as written */
    }
  }
  return text.replace(TOKEN, (whole, path: string) => values.get(path) ?? whole);
}

/** Read one path and return the parsed value, or undefined when unreadable. */
export async function readScope(job: ScopeReader, path: string): Promise<unknown> {
  try {
    const raw = decoder.decode(await job.cmdGetScope(path)).trim();
    if (raw === "") return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
}

function render(bytes: Uint8Array): string {
  const raw = decoder.decode(bytes).trim();
  if (raw === "") return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed === null) return "";
    if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}
