// smoke test — run: node test/smoke.js
// Pure-ES, same files run under qjs too (qjs -m test/smoke.js) once available.
"use strict";

import { parseToml, applyDefaults, ConfigError } from "../src/config.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`); }
}
function throws(name, fn) {
  try { fn(); fail++; console.error(`FAIL ${name}: no error thrown`); }
  catch (e) { if (e instanceof ConfigError) pass++; else { fail++; console.error(`FAIL ${name}: wrong error ${e.message}`); } }
}

// ---- tables + scalars
const c = parseToml(`[a]\nx = 5 # inline\ny = "has # hash"\nd = [-1, 0.5, true, "s"]\n[b.c]\ndeep = "ok"\n`);
eq("int", c.a.x, 5);
eq("string w hash", c.a.y, "has # hash");
eq("array", c.a.d, [-1, 0.5, true, "s"]);
eq("subtable", c.b.c.deep, "ok");

// ---- escapes
const e = parseToml(`v = "a\\nb\\t \\"q\\" \\\\"\n`, "t");
eq("escapes", e.v, "a\nb\t \"q\" \\");

// ---- empty table re-entry (append to existing section)
const r = parseToml("[a]\nx = 1\n\n[a]\ny = 2\n");
eq("table re-entry", r.a, { x: 1, y: 2 });

// ---- rejections
throws("bare value", () => parseToml("x = unquoted"));
throws("empty value", () => parseToml("x ="));
throws("unterminated string", () => parseToml('x = "abc'));
throws("unterminated array", () => parseToml("x = [1,"));
throws("unmatched header", () => parseToml("[a\nx = 1"));
throws("value-and-table", () => parseToml("a = 1\n[a]\nx = 2\n"));

// ---- defaults merge
const d = applyDefaults(parseToml("[llm]\nmodel = \"test-model\"\n"));
eq("default merged", d.llm.provider, "openai");
eq("override kept", d.llm.model, "test-model");
eq("defaults spread", parseToml("").llm, undefined);
const full = applyDefaults({});
eq("full defaults", full.llm.budgetTokens, 8000);

console.log(`smoke: ${pass} passed, ${fail} failed`);
if (globalThis.process) process.exit(fail ? 1 : 0);
else if (globalThis.std?.exit) std.exit(fail ? 1 : 0);
