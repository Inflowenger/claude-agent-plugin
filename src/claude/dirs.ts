// What directories there are to pick from, for the "Also readable" field.
//
// There is no closed set of paths, which is why that field stays typable — but
// the one list worth offering is the tree the connection already fences the node
// into, since a directory outside it is refused before Claude starts anyway.
// Breadth-first and shallow on purpose: a deep walk of a large checkout would
// keep a form button waiting, and nobody picks from four hundred rows.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Directories that are never what someone meant to hand an agent. */
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
]);

export interface DirScan {
  /** Absolute paths, nearest first. */
  dirs: string[];
  /** True when the cap cut the walk short. */
  truncated: boolean;
}

/**
 * The directories under `root`, breadth-first, hidden ones and the usual build
 * output left out. `root` itself is not included: it is where the node already
 * works by default.
 */
export function listDirs(root: string, depth = 2, cap = 150): DirScan {
  const dirs: string[] = [];
  let frontier = [root];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const name of childrenOf(parent)) {
        const path = join(parent, name);
        dirs.push(path);
        if (dirs.length >= cap) return { dirs, truncated: true };
        next.push(path);
      }
    }
    frontier = next;
  }
  return { dirs, truncated: false };
}

function childrenOf(parent: string): string[] {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    // A directory the plugin's user cannot read is one the agent could not read
    // either: leaving it out of the list is the honest answer.
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}
