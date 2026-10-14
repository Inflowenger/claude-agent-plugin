// The tool names a node may name, and what each one does.
//
// A tool list is the one field on the run form where "type the values yourself"
// fails: the names are exact strings from Claude Code, and nobody filling in a
// node for the first time knows them. So the field offers them instead — this
// catalogue while the drawer is still closed, and whatever the host's own Claude
// Code advertises once the Refresh button has been pressed.
//
// The catalogue is therefore a convenience, never an authority: it carries the
// names that are stable across builds, each with a line saying what it is for,
// and labels whatever the live list turns up. A host whose build differs (a
// native build serves search through Bash rather than Glob/Grep; an MCP server
// adds `mcp__…` tools) is one Refresh away from the truth.

/** One candidate for a multi-select: the exact name, and a line a human reads. */
export interface ToolOption {
  value: string;
  label?: string;
}

/** What each name this plugin knows about is for. */
const WHAT: Record<string, string> = {
  Read: "open a file on the host",
  Glob: "find files by name pattern",
  Grep: "search inside files",
  Edit: "change part of a file",
  Write: "create or overwrite a file",
  NotebookEdit: "change a Jupyter notebook cell",
  Bash: "run a shell command",
  BashOutput: "read a background command's output",
  KillShell: "stop a background shell",
  WebFetch: "read a URL",
  WebSearch: "search the web",
  Task: "hand a sub-task to a subagent",
  Agent: "hand a sub-task to a subagent",
  Skill: "load one of the host's skills",
  SlashCommand: "run one of the host's slash commands",
  TodoWrite: "keep its own task list",
  AskUserQuestion: "ask a person — this node's human branch",
  ExitPlanMode: "leave plan mode once a plan is ready",
  ToolSearch: "look up tools it does not have loaded",
  Monitor: "watch a file or command for a change",
  TaskStop: "stop work it started itself",
  ListAgents: "list the agents it can talk to",
  SendMessage: "message another agent",
  ReportFindings: "report review findings as a list",
};

/**
 * The names offered before anyone presses Refresh: the ones worth restricting an
 * agent to, in the order a person thinks about them — read, then change, then
 * run, then reach out.
 */
const CATALOGUE = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
  "TodoWrite",
  "AskUserQuestion",
];

/** The catalogue as multi-select options. */
export const BUILTIN_TOOLS: ToolOption[] = CATALOGUE.map(optionFor);

/**
 * The host's live tool list as options, labelled from the catalogue where the
 * name is known. An empty live list (an older CLI that does not advertise one)
 * falls back to the catalogue rather than to an empty picker.
 */
export function toolOptions(live: string[]): ToolOption[] {
  const named = live.map((t) => String(t).trim()).filter((t) => t !== "");
  if (named.length === 0) return BUILTIN_TOOLS;
  return named.map(optionFor);
}

function optionFor(name: string): ToolOption {
  const what = WHAT[name] ?? (name.startsWith("mcp__") ? mcpNote(name) : "");
  return { value: name, label: what ? `${name} — ${what}` : name };
}

/** `mcp__github__create_issue` → "from the github MCP server". */
function mcpNote(name: string): string {
  const server = name.split("__")[1] ?? "";
  return server ? `from the ${server} MCP server` : "from an MCP server";
}
