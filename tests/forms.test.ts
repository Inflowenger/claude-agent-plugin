// The forms are a contract with the drawer: both documents must parse, and
// neither may ask for a credential — the connection is the platform's half of
// the body, not something a user retypes on every node.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runForm, settingsFormBuilder } from "../src/actions/forms.js";
import { runPorts, TAG_ASK, TAG_DONE, TAG_EXCEPTION, TAG_LIMIT } from "../src/actions/ports.js";

test("every form's schema and ui parse as JSON", () => {
  for (const [name, form] of [["run", runForm()], ["settings", settingsFormBuilder()]] as const) {
    assert.ok(form.jsonschema, `${name}: no schema`);
    assert.ok(form.jsonui, `${name}: no ui`);
    JSON.parse(form.jsonschema!);
    JSON.parse(form.jsonui!);
  }
});

test("the action form never declares a settings property", () => {
  const schema = JSON.parse(runForm().jsonschema!) as { properties: Record<string, unknown> };
  assert.equal(schema.properties.settings, undefined);
  for (const name of Object.keys(schema.properties)) {
    assert.ok(!/key|token|secret|password/i.test(name), `action form asks for a credential: ${name}`);
  }
});

test("the task field is required and the human loop is on by default", () => {
  const schema = JSON.parse(runForm().jsonschema!) as {
    required?: string[];
    properties: Record<string, { default?: unknown }>;
  };
  assert.ok(schema.required?.includes("prompt"));
  assert.equal(schema.properties.askHuman?.default, true);
  assert.equal(schema.properties.session?.default, "continue");
  assert.equal(schema.properties.permissionMode?.default, "auto");
});

test("the ports are the four the handler routes, with stable tags", () => {
  assert.deepEqual(
    runPorts.map((p) => p.tags),
    [[TAG_DONE], [TAG_ASK], [TAG_LIMIT], [TAG_EXCEPTION]],
  );
  for (const port of runPorts) {
    assert.ok(port.title.trim() !== "", "a port with no title has no handle id on the canvas");
    assert.ok(port.description && port.description.trim() !== "", `${port.title}: no description`);
  }
});
