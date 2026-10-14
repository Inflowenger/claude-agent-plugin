// Multi-select: an array field a person picks from instead of typing into.
//
// formkit has `list` (an array of free-text rows) and `enumOf` (one value out of
// a fixed set), but nothing that is both — and the fields that need both are the
// ones where an empty form is a dead end: a first-time user cannot type the name
// of a tool they have never seen. So this file adds the two halves of a
// multi-select:
//
//   multiSelect()  the field — an array whose ITEMS carry the choices, which is
//                  how JSON Forms knows to draw tick boxes rather than rows.
//   chooseMany()   the refresh — formkit.choose for an array property. The one
//                  in the SDK writes `oneOf` onto the property itself, which is
//                  right for a drop-down and wrong for an array: it would ask
//                  the renderer for an array that IS one of the names.
//
// A set that cannot change (the five effort levels) needs no refresh and should
// stay a plain enum. A set the host decides (its tools, its directories) gets
// the button, and the handler answers with chooseMany.

import { formkit } from "@inflowenger/node-plugin-sdk";
import type { FormBuilder } from "@inflowenger/node-plugin-sdk";

/** One candidate: the exact value, and the label a human reads. */
export interface Option {
  value: string;
  label?: string;
}

/**
 * A multi-select field: an array of strings whose items are the given choices.
 *
 * `uniqueItems` is not decoration — it is what the JSON Forms renderer tests to
 * decide between "rows of selects" and one tick-box list, and picking the same
 * tool twice means nothing anyway.
 */
export function multiSelect(name: string, title: string, options: Option[]): formkit.Field {
  return formkit
    .listOf(name, title, "string")
    .set("uniqueItems", true)
    .set("items", itemsOf(options));
}

/** The items subschema that carries the choices. */
function itemsOf(options: Option[]): Record<string, unknown> {
  return { type: "string", oneOf: formkit.oneOf(options) };
}

/**
 * Rebuild the open form with a new set of choices on one array property — the
 * answer a Refresh button returns.
 *
 * Like formkit.picker, this is a *form envelope*: the host re-renders the dialog
 * from the documents returned here, because a field's choices live in the schema
 * and a patch can only touch data. Only envelope keys may appear in it.
 */
export function pickerMany(
  form: FormBuilder,
  target: string,
  options: Option[],
  data: Record<string, unknown>,
  heading: formkit.Notification,
): Record<string, unknown> {
  if (!form.jsonschema) {
    throw new Error("pick: cannot rebuild a form that has no schema");
  }
  const schema = JSON.parse(form.jsonschema) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const property = properties?.[target] as Record<string, unknown> | undefined;
  if (!property) {
    throw new Error(`pick: the form has no property "${target}" to fill with choices`);
  }
  if (property.type !== "array") {
    throw new Error(`pick: "${target}" is not an array property — use formkit.choose for a single value`);
  }
  property.items = itemsOf(options);
  property.uniqueItems = true;
  // An enum on the property itself would be intersected with the new items to
  // nothing; a stale items.enum would do the same to the labels.
  delete property.enum;

  const envelope: Record<string, unknown> = { schema, uischema: form.jsonui, data };
  if (heading.message && heading.message !== "") {
    envelope[formkit.NotifKey] = heading;
  }
  return envelope;
}

/**
 * pickerMany with the fallback every caller wants: a form that cannot be rebuilt
 * reports what it found as text, so the button never looks broken.
 */
export function chooseMany(
  form: FormBuilder,
  target: string,
  options: Option[],
  data: Record<string, unknown>,
  heading: formkit.Notification,
): unknown {
  try {
    return pickerMany(form, target, options, data, heading);
  } catch {
    const message = (heading.message ?? "").replace(/\n+$/, "");
    return new formkit.Notification({
      severity: formkit.orDefault(heading.severity, "info"),
      field: formkit.orDefault(heading.field, target),
      message: (message + "\n" + formkit.lines(options)).trim(),
    }).patch(null);
  }
}

/**
 * The choices, plus whatever the field already holds that is not among them.
 *
 * A rebuilt schema is the whole truth about the field: a value the new options
 * do not list is one the renderer may drop on the next keystroke. Keeping it
 * means a refresh never quietly unconfigures a working node — a tool the host no
 * longer advertises stays ticked, and stays visible as the odd one out.
 */
export function withCurrent(options: Option[], current: string[]): Option[] {
  const known = new Set(options.map((o) => o.value));
  const extra = current.filter((v) => v !== "" && !known.has(v));
  if (extra.length === 0) return options;
  return [...options, ...extra.map((value) => ({ value, label: `${value} — not offered by this host` }))];
}

/** What an array field currently holds, as trimmed strings. */
export function rowsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => v !== "");
}

/** Which field a lookup button asked about; `fallback` when the host said nothing. */
export function targetOf(call: Record<string, unknown>, fallback: string): string {
  const target = call.targetField;
  return typeof target === "string" && target.trim() !== "" ? target.trim() : fallback;
}
