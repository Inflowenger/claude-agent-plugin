// The ask-human bridge: what a person is shown, and what their words become
// when they go back to Claude.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { answerPayload, freshReply, readQuestions, renderPrompt, renderReply } from "../src/claude/ask.js";

const asked = readQuestions({
  questions: [
    {
      question: "Should the report be Short or Detailed?",
      header: "Report",
      multiSelect: false,
      options: [
        { label: "Short", description: "A concise summary" },
        { label: "Detailed", description: "Full explanation" },
      ],
    },
  ],
});

test("the tool input is read defensively", () => {
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.options.length, 2);
  assert.deepEqual(readQuestions(null), []);
  assert.deepEqual(readQuestions({ questions: "nonsense" }), []);
  assert.deepEqual(readQuestions({ questions: [{ header: "no text" }] }), []);
});

test("the prompt a person reads carries the options and how to answer", () => {
  const prompt = renderPrompt(asked);
  assert.match(prompt, /Should the report be Short or Detailed\?/);
  assert.match(prompt, /- Short — A concise summary/);
  assert.match(prompt, /in your own words/);
});

test("a reply that names an option is normalized to that option's label", () => {
  const payload = answerPayload(asked, "detailed") as { answers: Record<string, string>; response?: string };
  assert.equal(payload.answers["Should the report be Short or Detailed?"], "Detailed");
  assert.equal(payload.response, undefined, "a clean pick is not also reported as prose");
});

test("an option named inside a sentence is matched on a word boundary", () => {
  const payload = answerPayload(asked, "let's go with Detailed, but keep it under two pages") as {
    answers: Record<string, string>;
    response?: string;
  };
  assert.equal(payload.answers["Should the report be Short or Detailed?"], "Detailed");
});

test("free text is passed through as the answer and reported as prose", () => {
  const payload = answerPayload(asked, "neither — just the diff") as {
    answers: Record<string, string>;
    response?: string;
  };
  assert.equal(payload.answers["Should the report be Short or Detailed?"], "neither — just the diff");
  assert.equal(payload.response, "neither — just the diff");
});

test("the questions ride back unchanged, as the tool requires", () => {
  const payload = answerPayload(asked, "Short") as { questions: unknown };
  assert.deepEqual(payload.questions, asked);
});

test("a multiSelect reply collects every option it names", () => {
  const multi = readQuestions({
    questions: [
      {
        question: "Which sections?",
        header: "Sections",
        multiSelect: true,
        options: [{ label: "Intro" }, { label: "Findings" }, { label: "Appendix" }],
      },
    ],
  });
  const payload = answerPayload(multi, "Intro and Findings please") as { answers: Record<string, string> };
  assert.equal(payload.answers["Which sections?"], "Intro, Findings");
});

test("a Human in the Loop outcome renders as the answers it collected", () => {
  const reply = renderReply({
    status: "closed",
    answers: [
      { question: "Should the report be Short or Detailed?", answer: "Detailed" },
      { question: "By when?", answer: "Friday" },
    ],
    text: "User: hello\nAssistant: hi",
    closedAt: 1760000000,
  });
  assert.equal(reply, "Should the report be Short or Detailed? — Detailed\nBy when? — Friday");
});

test("a reply the flow left in another shape is still readable", () => {
  assert.equal(renderReply("just a string"), "just a string");
  assert.equal(renderReply({ text: "from the transcript" }), "from the transcript");
  assert.equal(renderReply({ answers: [] , text: "fallback" }), "fallback");
  assert.equal(renderReply(undefined), "");
  assert.equal(renderReply({ unexpected: 1 }), '{"unexpected":1}');
});

test("a reply settled before this node's last run is not reused", () => {
  const hitl = { status: "closed", answers: [{ question: "q", answer: "Detailed" }], closedAt: 1000 };
  // The node parked, the person answered at 1000, the node finished that run at 900.
  assert.equal(freshReply(hitl, 900), "q — Detailed");
  // A later run finished at 1100: the same reply is now from an earlier round.
  assert.equal(freshReply(hitl, 1100), "");
});

test("without timestamps a reply is used rather than silently dropped", () => {
  assert.equal(freshReply("Bullet points", 0), "Bullet points");
  assert.equal(freshReply("Bullet points", 1100), "Bullet points");
  assert.equal(freshReply({ status: "closed", answers: [{ question: "q", answer: "a" }] }, 1100), "q — a");
});
