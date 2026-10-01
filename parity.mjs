#!/usr/bin/env node
// Correctness, not speed: which imports detangle and dependency-cruiser
// report on cycles, compared import by import on one corpus.
//
//   node parity.mjs excalidraw
//
// dependency-cruiser (configs/dependency-cruiser.cjs, as in bench.mjs)
// follows TypeScript's type-only imports when finding cycles; detangle by
// default doesn't (they vanish at compile time, so they make no runtime
// cycle). So detangle runs twice: with its defaults, and with
// `cycles_ignore_type_only = false`, which is the like-for-like comparison.
// Every import that one tool reports and the other doesn't is then checked
// against dependency-cruiser's own dependency graph: is there a path back
// from the imported file to the importing one there?
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = (name) => path.join(here, "node_modules", ".bin", name);
const corpora = JSON.parse(fs.readFileSync(path.join(here, "corpora.json"), "utf8"));
const name = process.argv[2];
if (!corpora[name]) {
  console.error(`usage: parity.mjs <${Object.keys(corpora).join("|")}> (run bench.mjs once first, to clone it)`);
  process.exit(2);
}
const c = corpora[name];
const root = path.join(here, "corpora", name);
const tsconfig = path.join(root, c.tsconfig);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "detangle-parity-"));

/** Runs a tool that may exit non-zero on findings; returns parsed JSON stdout. */
function json(cmd, args, env = {}) {
  const out = path.join(tmp, "out.json");
  try {
    execFileSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", fs.openSync(out, "w"), "ignore"], maxBuffer: 1 << 30 });
  } catch {
    // Exit status 1 means findings.
  }
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

console.error(`running dependency-cruiser and detangle on ${c.label}…`);
const dc = json(bin("depcruise"), [c.dir, "--config", path.join(here, "configs/dependency-cruiser.cjs"), "--output-type", "json"], { BENCH_TSCONFIG: tsconfig });
const dtDefault = json(bin("detangle"), ["check", c.dir, "-f", "json"]);
// detangle's built-in rules, written out, with type-only imports in cycles.
execFileSync(bin("detangle"), ["init", tmp], { stdio: "ignore" });
const toml = path.join(tmp, "detangle.toml");
fs.writeFileSync(toml, fs.readFileSync(toml, "utf8").replace("cycles_ignore_type_only = true", "cycles_ignore_type_only = false"));
const dtTypes = json(bin("detangle"), ["check", c.dir, "-f", "json", "-c", toml]);

const key = (v) => `${v.from} -> ${v.to}`;
const reported = (list) => new Set(list.map(key));
const dcCycles = reported(dc.summary.violations.filter((v) => v.rule.name === "no-circular"));
const dtCycles = reported(dtDefault.filter((v) => v.rule === "no-circular"));
const dtTypeCycles = reported(dtTypes.filter((v) => v.rule === "no-circular"));
const minus = (a, b) => [...a].filter((x) => !b.has(x));

// dependency-cruiser's own graph: its imports, and which it marks circular.
const adj = new Map();
const marked = new Map();
for (const m of dc.modules) {
  adj.set(m.source, []);
  for (const d of m.dependencies) {
    if (!d.resolved) continue;
    adj.get(m.source).push(d.resolved);
    marked.set(`${m.source} -> ${d.resolved}`, d.circular);
  }
}
const pathBack = (p) => {
  const [from, to] = p.split(" -> ");
  const seen = new Set([to]);
  const stack = [to];
  while (stack.length) {
    const x = stack.pop();
    if (x === from) return true;
    for (const y of adj.get(x) ?? []) if (!seen.has(y)) seen.add(y), stack.push(y);
  }
  return false;
};

const onlyDc = minus(dcCycles, dtTypeCycles);
const onlyDt = minus(dtTypeCycles, dcCycles);
const tally = (list, f) => list.reduce((o, p) => ((o[f(p)] = (o[f(p)] ?? 0) + 1), o), {});

console.log(`## ${c.label} (${c.commit.slice(0, 10)}): imports reported on cycles\n`);
console.log(`- dependency-cruiser: ${dcCycles.size}`);
console.log(`- detangle, defaults (type-only imports make no cycle): ${dtCycles.size}`);
console.log(`- detangle, counting type-only imports (like dependency-cruiser here): ${dtTypeCycles.size}\n`);
console.log(`Like for like, imports only dependency-cruiser reports: ${onlyDc.length}`);
for (const [k, n] of Object.entries(tally(onlyDc, (p) => (pathBack(p) ? "on a cycle in its own graph" : "no path back in its own graph")))) console.log(`  - ${k}: ${n}`);
console.log(`Like for like, imports only detangle reports: ${onlyDt.length}`);
const why = (p) => {
  if (!marked.has(p)) return "not in dependency-cruiser's graph";
  if (marked.get(p)) return "marked circular in dependency-cruiser's own graph, but not reported";
  return pathBack(p) ? "not marked circular, though its own graph has a path back" : "no path back in dependency-cruiser's graph";
};
for (const [k, n] of Object.entries(tally(onlyDt, why))) console.log(`  - ${k}: ${n}`);
fs.rmSync(tmp, { recursive: true, force: true });
