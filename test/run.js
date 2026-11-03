#!/usr/bin/env node
/**
 * A tiny test runner: no dependencies, Node 18+.
 *   node test/run.js            every test/*.test.js
 *   node test/run.js pool       only files whose name contains "pool"
 * Each test file default-exports async ({ t, eq, group }) => {...}.
 * `cloudflare:workers` is resolved to a small shim (test/support/cloudflare-workers.js).
 */
import { register } from "node:module";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { isDeepStrictEqual, inspect } from "node:util";

register("./support/hooks.mjs", import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || "";
const files = readdirSync(here).filter((f) => f.endsWith(".test.js") && f.includes(filter)).sort();

let pass = 0, fail = 0;
const failures = [];
let current = "";
const t = (name, ok, why) => {
  if (ok) { pass++; return; }
  fail++; failures.push(`${current} :: ${name}${why ? " - " + why : ""}`);
};
const eq = (name, got, want) => t(name, isDeepStrictEqual(got, want), `got ${inspect(got, { depth: 4 })}, want ${inspect(want, { depth: 4 })}`);
const group = async (name, fn) => { current = name; try { await fn(); } catch (e) { fail++; failures.push(`${name} :: threw ${e && e.stack || e}`); } };

for (const f of files) {
  const before = pass + fail;
  const mod = await import(pathToFileURL(join(here, f)).href);
  current = f;
  try { await mod.default({ t, eq, group }); } catch (e) { fail++; failures.push(`${f} :: threw ${e && e.stack || e}`); }
  console.log(`${f.padEnd(28)} ${pass + fail - before} assertions`);
}
for (const x of failures) console.log("FAIL " + x);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
