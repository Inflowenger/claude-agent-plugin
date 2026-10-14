// The node's outbound branches.
//
// These are the plugin's half of a contract with the canvas: the whole list is
// served on `@actions`, FloMorphic's extension sync stores it on the action's
// palette row, and the designer renders one output port per entry — labelled by
// `title`, explained by `description` — stamping that port's `tags` onto every
// edge drawn from it. At run time the handler names the branch(es) that fire
// with `job.cmdNextFilter(tags)`.
//
// Two consequences worth stating, because they are what makes ports a contract
// rather than configuration:
//
//   * They are not editable on the canvas. The drawer has no editor for a plugin
//     action's ports; they are re-stamped from the registry when the node is
//     added and when a flow is imported. A flow author can leave a port
//     unwired, but cannot remove or rename one — the shape of the branch belongs
//     to the plugin.
//   * An action that declares ports has NO default handle, so every edge leaving
//     it must name one. A port left unwired simply ends that branch of the run.
//
// Tag names are the wire contract: renaming one orphans the edges already drawn
// from its port, so treat them as fixed once published.

import type { OutboundPort } from "@inflowenger/node-plugin-sdk";

/** The turn finished and Claude has an answer. */
export const TAG_DONE = "done";
/** Claude asked for a person. The session is parked mid-question. */
export const TAG_ASK = "ask";
/** The turn hit its own ceiling (turns or budget) with work left to do. */
export const TAG_LIMIT = "limit";
/**
 * The reserved failure tag. The runtime fires it the same way as any other, so a
 * failed node still routes — the flow decides what a failure means.
 */
export const TAG_EXCEPTION = "_exception";

export const runPorts: OutboundPort[] = [
  {
    title: "Answer",
    tags: [TAG_DONE],
    description: "Claude finished this turn. Its answer — and the structured output, when a schema was set — is on the node's scope.",
  },
  {
    title: "Needs a human",
    tags: [TAG_ASK],
    description:
      "Claude asked a question and the session is parked on it. Wire this to a Human in the Loop node (park mode) and bring its reply back to this node: the same session resumes with the answer.",
  },
  {
    title: "Limit reached",
    tags: [TAG_LIMIT],
    description:
      "The turn ran out of turns or budget with work unfinished. Run the node again to continue the same session, or branch to an escalation.",
  },
  {
    title: "Failed",
    tags: [TAG_EXCEPTION],
    description: "Claude could not run, or ended in an error. The reason is on the node's output.",
  },
];
