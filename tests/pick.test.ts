// A multi-select is only a multi-select if the choices sit on the array's
// ITEMS: put them on the property and the renderer draws rows of selects, or
// nothing at all. These tests pin that shape, because nothing else will — a
// wrong schema still parses, still builds, and only fails in someone's drawer.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { formkit } from "@inflowenger/node-plugin-sdk";

import { runForm } from "../src/actions/forms.js";
import { chooseMany, multiSelect, rowsOf, targetOf, withCurrent } from "../src/actions/pick.js";
import { BUILTIN_TOOLS, toolOptions } from "../src/claude/tools.js";

function propertyOf(schema: unknown, name: string): Record<string, unknown> {
  const properties = (schema as { properties: Record<string, unknown> }).properties;
  return properties[name] as Record<string, unknown>;
}

test("a multi-select is an array whose items carry the choices", () => {
  const field = multiSelect("tools", "Tools", [{ value: "Bash", label: "Bash — run a shell command" }]);
  assert.equal(field.schema.type, "array");
  assert.equal(field.schema.uniqueItems, true);
  assert.deepEqual(field.schema.items, {
    type: "string",
    oneOf: [{ const: "Bash", title: "Bash — run a shell command" }],
  });
  // The choices must not also sit on the property: the two would be intersected.
  assert.equal(field.schema.enum, undefined);
  assert.equal(field.schema.oneOf, undefined);
});

test("both tool fields render as pickers with a refresh button", () => {
  const form = runForm();
  const schema = JSON.parse(form.jsonschema!);
  const ui = JSON.parse(form.jsonui!) as { elements: { elements?: Record<string, unknown>[] }[] };

  for (const name of ["tools", "disallowedTools"]) {
    const property = propertyOf(schema, name);
    assert.equal(property.type, "array", `${name}: not an array`);
    assert.equal(property.uniqueItems, true, `${name}: not a multi-select`);
    const items = property.items as { oneOf?: unknown[] };
    assert.ok((items.oneOf?.length ?? 0) > 0, `${name}: no choices to pick from`);
  }

  // Every array field carries a button, because a list nobody can enumerate is
  // the reason this exists.
  const controls = ui.elements.flatMap((e) => e.elements ?? [e as Record<string, unknown>]);
  for (const name of ["tools", "disallowedTools", "additionalDirectories"]) {
    const control = controls.find((c) => c.scope === `#/properties/${name}`);
    const ui = control?.[formkit.uiKey] as { action?: { fn?: string } } | undefined;
    assert.ok(ui?.action?.fn, `${name}: no refresh button`);
  }
});

test("a refresh rebuilds the whole form with the new choices on that one field", () => {
  const answer = chooseMany(
    runForm(),
    "tools",
    toolOptions(["Read", "mcp__github__create_issue"]),
    { prompt: "do the thing", tools: ["Read"] },
    formkit.success("2 tools on this host"),
  ) as Record<string, unknown>;

  // A form envelope carries envelope keys only: one stray field name and the
  // host demotes the whole answer to a patch, and nothing re-renders.
  assert.deepEqual(
    Object.keys(answer).sort(),
    ["data", "schema", "uischema", formkit.NotifKey].sort(),
  );
  const items = propertyOf(answer.schema, "tools").items as { oneOf: { const: string; title: string }[] };
  assert.deepEqual(items.oneOf.map((o) => o.const), ["Read", "mcp__github__create_issue"]);
  assert.match(items.oneOf[1].title, /github MCP server/);
  // Everything else about the form survives the rebuild.
  assert.deepEqual(propertyOf(answer.schema, "disallowedTools").type, "array");
  assert.deepEqual((answer.data as { tools: string[] }).tools, ["Read"]);
});

test("a refresh of a field that is not an array falls back to text", () => {
  const answer = chooseMany(
    runForm(),
    "model",
    [{ value: "a" }, { value: "b" }],
    {},
    formkit.success("found 2"),
  ) as Record<string, unknown>;
  const note = answer[formkit.NotifKey] as { message: string; field?: string };
  assert.equal(answer.schema, undefined, "a scalar must not be rebuilt as an array");
  assert.match(note.message, /found 2/);
  assert.match(note.message, /a\n/);
  assert.equal(note.field, "model");
});

test("a refresh never silently drops what the field already holds", () => {
  const options = withCurrent(toolOptions(["Read"]), ["Read", "Grep"]);
  assert.deepEqual(options.map((o) => o.value), ["Read", "Grep"]);
  assert.match(options[1].label!, /not offered by this host/);
});

test("the catalogue stands in when the host advertises nothing", () => {
  assert.deepEqual(toolOptions([]), BUILTIN_TOOLS);
  assert.ok(BUILTIN_TOOLS.every((o) => o.label && o.label.includes(" — ")), "a name with no explanation helps nobody");
  assert.ok(BUILTIN_TOOLS.some((o) => o.value === "Bash"));
});

test("the button says which field it speaks for", () => {
  assert.equal(targetOf({ targetField: "disallowedTools" }, "tools"), "disallowedTools");
  assert.equal(targetOf({}, "tools"), "tools");
  assert.deepEqual(rowsOf(["  Read ", "", "Bash"]), ["Read", "Bash"]);
  assert.deepEqual(rowsOf("Read"), []);
});
