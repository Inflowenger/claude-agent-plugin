// Ask-human: how a question Claude raises mid-run becomes a branch on the canvas.
//
// A flow run is seconds long and a person is not. The runtime gives up on a job
// that sends no command for its idle window, so a plugin that blocked inside
// `canUseTool` waiting for an answer would hang the node and lose the session.
//
// Claude Code has a decision built for exactly this: a `PreToolUse` hook may
// answer `defer`, which executes nothing, ends the process with
// `stop_reason: "tool_deferred"`, and leaves the pending tool call in the
// session transcript. The host then collects the answer however it likes — here,
// by routing an outbound port into whatever the flow author wired (a Human in
// the Loop node, a Telegram task, an approval sub-flow) — and resumes the
// session later, where the SAME tool call fires the hook again and we answer it
// with `allow` + the human's words.
//
// So the two halves of one conversation are two runs of one node, and nothing is
// held open in between. See docs/detached-work.md in the Node SDK for the
// pattern this is an instance of.

/** The question as it is committed to the flow's context on the `ask` branch. */
export interface Question {
  /** The deferred tool call's id — stable across the resume, useful in logs. */
  toolUseId: string;
  /** The tool that asked. `AskUserQuestion` today. */
  tool: string;
  /**
   * The questions rendered as one block of prose, ready to drop into a Human in
   * the Loop node's prompt with `{{$.claude.question.prompt}}`. A person should
   * never have to walk a JSON shape to read what they were asked.
   */
  prompt: string;
  /** The structured form, for a flow that routes on the options rather than prose. */
  questions: AskedQuestion[];
}

export interface AskedQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** Read the tool input Claude generated for `AskUserQuestion`, defensively. */
export function readQuestions(toolInput: unknown): AskedQuestion[] {
  const raw = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    if (!q || typeof q !== "object") return [];
    const o = q as Record<string, unknown>;
    const text = String(o.question ?? "").trim();
    if (!text) return [];
    const options = Array.isArray(o.options)
      ? o.options.flatMap((opt) => {
          if (!opt || typeof opt !== "object") return [];
          const label = String((opt as Record<string, unknown>).label ?? "").trim();
          if (!label) return [];
          const description = String((opt as Record<string, unknown>).description ?? "").trim();
          return [description ? { label, description } : { label }];
        })
      : [];
    return [{
      question: text,
      header: String(o.header ?? "").trim(),
      multiSelect: o.multiSelect === true,
      options,
    }];
  });
}

/** Render the questions as the prose a person reads. */
export function renderPrompt(questions: AskedQuestion[]): string {
  if (questions.length === 0) return "Claude is waiting for an answer but asked nothing readable.";
  const parts = questions.map((q) => {
    const head = q.header ? `**${q.header}** — ${q.question}` : `**${q.question}**`;
    const opts = q.options.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    const note = q.multiSelect && q.options.length ? "\n(more than one may apply)" : "";
    return opts.length ? `${head}\n${opts.join("\n")}${note}` : head;
  });
  const closing =
    "\nAnswer in your own words, or name one of the options above. Your reply goes straight back to Claude, which continues the same session.";
  return parts.join("\n\n") + closing;
}

/**
 * The human's reply, as it came out of the flow's context, turned into the shape
 * `AskUserQuestion` takes back.
 *
 * `answers` maps each question's own text to a value. A reply that names one of
 * the options is normalized to that option's exact label, so Claude sees the
 * choice it offered; anything else is passed through verbatim, which the tool
 * documents as the way to carry free text. `response` carries the whole reply as
 * well, for the case where the person answered around the questions rather than
 * inside them.
 */
export function answerPayload(
  questions: AskedQuestion[],
  reply: string,
): Record<string, unknown> {
  const text = reply.trim();
  const answers: Record<string, string> = {};
  let matchedEvery = questions.length > 0;

  for (const q of questions) {
    const hit = matchOption(q, text);
    if (hit) answers[q.question] = hit;
    else {
      answers[q.question] = text;
      matchedEvery = false;
    }
  }
  const payload: Record<string, unknown> = { questions, answers };
  // Only when the reply was not a clean pick: tell Claude what the person
  // actually said, rather than pretending prose was a selection.
  if (!matchedEvery) payload.response = text;
  return payload;
}

/**
 * Find the option a reply names. Exact label wins; otherwise a label that
 * appears as a whole word in the reply ("let's go with Detailed, but ..."), the
 * longest such label first so "Detailed report" beats "Detail".
 */
function matchOption(q: AskedQuestion, reply: string): string | undefined {
  const lower = reply.toLowerCase();
  const exact = q.options.find((o) => o.label.toLowerCase() === lower);
  if (exact) return exact.label;
  if (q.multiSelect) {
    const picked = q.options.filter((o) => wholeWord(lower, o.label.toLowerCase()));
    if (picked.length > 0) return picked.map((o) => o.label).join(", ");
    return undefined;
  }
  const byLength = [...q.options].sort((a, b) => b.label.length - a.label.length);
  return byLength.find((o) => wholeWord(lower, o.label.toLowerCase()))?.label;
}

function wholeWord(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? " " : haystack[i - 1];
  const after = i + needle.length >= haystack.length ? " " : haystack[i + needle.length];
  return /[^a-z0-9]/.test(before) && /[^a-z0-9]/.test(after);
}

/**
 * Render whatever the flow left at the answer path into the words to hand back.
 *
 * The Human in the Loop node commits an object — `{ status, answers: [{question,
 * answer}], messages, text, closedAt }` — but the path may equally point at a
 * plain string another node wrote, or at a whole sub-document. Accept all three
 * rather than making the flow author reshape their context to suit this plugin.
 */
/**
 * The reply, but only if it can have been meant for the question this node last
 * parked on.
 *
 * The answer path is an ordinary place in the context: it still holds the LAST
 * reply after the loop moves on, so a later run — one that ran out of turns, say,
 * and is simply being run again — would otherwise find an old answer sitting
 * there and hand it to Claude as though a person had just spoken.
 *
 * A Human in the Loop outcome is stamped with `closedAt`, and the engine tells
 * the node when its own previous run finished (`_registry.doneAt`). A reply
 * settled BEFORE this node last finished belongs to an earlier round. When
 * either timestamp is missing nothing can be proven, and the reply is used:
 * answering a waiting question is the common case, and the alternative is a
 * conversation that silently never hears back.
 */
export function freshReply(value: unknown, previousRunDoneAt: number): string {
  const closedAt = closedAtOf(value);
  if (closedAt > 0 && previousRunDoneAt > 0 && closedAt < previousRunDoneAt) return "";
  return renderReply(value);
}

function closedAtOf(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  for (const key of ["closedAt", "answeredAt", "updatedAt"]) {
    const v = (value as Record<string, unknown>)[key];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function renderReply(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(renderReply).filter(Boolean).join("\n");

  const o = value as Record<string, unknown>;
  // A HITL outcome: the answers are the point, the transcript is the fallback.
  if (Array.isArray(o.answers)) {
    const lines = o.answers.flatMap((a) => {
      if (!a || typeof a !== "object") return [];
      const rec = a as Record<string, unknown>;
      const q = String(rec.question ?? "").trim();
      const ans = String(rec.answer ?? "").trim();
      if (!ans) return [];
      return [q ? `${q} — ${ans}` : ans];
    });
    if (lines.length > 0) return lines.join("\n");
  }
  for (const key of ["text", "answer", "reply", "message", "value", "result"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return JSON.stringify(value);
}
