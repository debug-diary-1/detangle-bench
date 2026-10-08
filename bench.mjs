#!/usr/bin/env node
// Times detangle and other JavaScript dependency tools on the same
// repositories, each checking for the problems it's built to find.
//
//   npm ci
//   node bench.mjs                        # every corpus and tool
//   node bench.mjs --corpus excalidraw    # one corpus
//   node bench.mjs --tools detangle,madge # some tools
//   node bench.mjs --runs 10              # runs per tool (default below)
//   node bench.mjs --force                # measure even if the machine is busy
//
// The corpora (corpora.json) are cloned at pinned commits into corpora/, and
// their npm dependencies installed, so imports of packages resolve. Each
// tool runs as a fresh process; wall time is measured here, CPU time and
// peak memory by /usr/bin/time. Prints a Markdown table and writes
// results/<date>.json, in the shape the detangle site reads.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = (name) => path.join(here, "node_modules", ".bin", name);
// detangle's native binary, from the platform package npm installed. The
// `detangle` command npm links is a small Node.js launcher that starts this
// binary; timing that would add Node's startup (~25-30 ms) to every run,
// which is most of a small project's time.
const detangleBin = (() => {
  const platforms = JSON.parse(fs.readFileSync(path.join(here, "node_modules/detangle/platforms.json"), "utf8"));
  const libc = process.platform === "linux" ? (process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl") : undefined;
  const p = platforms.find((p) => p.os === process.platform && p.cpu === process.arch && (p.libc === undefined || p.libc === libc));
  return path.join(here, "node_modules", p.package, "bin", process.platform === "win32" ? "detangle.exe" : "detangle");
})();
const corpora = JSON.parse(fs.readFileSync(path.join(here, "corpora.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const only = opt("corpus")?.split(",") ?? Object.keys(corpora);
const runsOverride = opt("runs") && Number(opt("runs"));
const force = args.includes("--force");

// ---------------------------------------------------------------- tools

/**
 * Each tool: the command for a corpus, how many runs (slow tools fewer),
 * and how to count what it found in its JSON output.
 */
const TOOLS = [
  {
    name: "detangle",
    runs: 30,
    cmd: (c) => [detangleBin, "check", c.dir, "-f", "json"],
    found: (out) => counts(JSON.parse(out), (v) => v.rule),
  },
  {
    name: "detangle (cached)",
    runs: 30,
    cache: true,
    cmd: (c, cache) => [detangleBin, "check", c.dir, "-f", "json", "--cache", cache],
    found: (out) => counts(JSON.parse(out), (v) => v.rule),
  },
  {
    name: "dependency-cruiser",
    runs: 5,
    cmd: (c) => [bin("depcruise"), c.dir, "--config", path.join(here, "configs/dependency-cruiser.cjs"), "--output-type", "json"],
    found: (out) => counts(JSON.parse(out).summary.violations, (v) => v.rule.name),
  },
  {
    name: "dependency-cruiser (cached)",
    runs: 5,
    cache: true,
    cmd: (c, cache) => [bin("depcruise"), c.dir, "--config", path.join(here, "configs/dependency-cruiser.cjs"), "--output-type", "json", "--cache", cache],
    found: (out) => counts(JSON.parse(out).summary.violations, (v) => v.rule.name),
  },
  {
    name: "madge --circular",
    runs: 3,
    cmd: (c) => [bin("madge"), "--circular", "--extensions", "ts,tsx", "--ts-config", c.tsconfig, "--json", "--no-spinner", c.dir],
    found: (out) => ({ cycles: JSON.parse(out).length }),
  },
  {
    name: "oxlint import/no-cycle",
    runs: 5,
    // Only import/no-cycle (configs/oxlint.json), on every core, as oxlint
    // runs by default. It finds each file's tsconfig; the corpus's own oxlint
    // configs, if any, are ignored.
    cmd: (c) => [bin("oxlint"), "--config", path.join(here, "configs/oxlint.json"), "--disable-nested-config", "--tsconfig", c.tsconfig, "--format", "json", c.dir],
    found: (out) => counts(JSON.parse(out).diagnostics, (d) => d.code ?? "parse error"),
  },
  {
    name: "ESLint import/no-cycle",
    runs: 3,
    // One run on a big corpus: VS Code takes minutes.
    slow: true,
    cmd: (c) => [bin("eslint"), "--config", path.join(here, "configs/eslint.config.cjs"), "--no-inline-config", "--format", "json", c.dir],
    found: (out) => counts(JSON.parse(out).flatMap((f) => f.messages), (m) => m.ruleId ?? "parse error"),
  },
];
const tools = opt("tools") ? TOOLS.filter((t) => opt("tools").split(",").some((n) => t.name.startsWith(n))) : TOOLS;

function counts(items, key) {
  const out = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------- corpora

function prepare(name) {
  const c = corpora[name];
  const dir = path.join(here, "corpora", name);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "inherit" });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    console.error(`cloning ${c.repo} at ${c.commit.slice(0, 10)}…`);
    git("init", "-q");
    git("fetch", "-q", "--depth", "1", c.repo, c.commit);
    git("checkout", "-q", "FETCH_HEAD");
  }
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== c.commit) throw new Error(`${dir} is at ${head}, not ${c.commit}; delete it to re-clone`);
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    // Packages only, no install scripts (VS Code's build native modules).
    console.error(`installing ${name}'s dependencies…`);
    const lock = fs.existsSync(path.join(dir, "yarn.lock")) ? "yarn" : fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ? "pnpm" : "npm";
    if (lock === "pnpm") execFileSync("npx", ["--yes", JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).packageManager ?? "pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--reporter=silent"], { cwd: dir, stdio: "inherit" });
    else if (lock === "yarn") execFileSync("npx", ["--yes", "yarn@1", "install", "--frozen-lockfile", "--ignore-scripts", "--silent"], { cwd: dir, stdio: "inherit" });
    else execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: "inherit" });
  }
  return { ...c, name, root: dir, tsconfig: path.join(dir, c.tsconfig) };
}

// ---------------------------------------------------------------- measuring

const mac = process.platform === "darwin";
const timeArgs = mac ? ["-l"] : ["-f", "BENCH %e %U %S %M"];

/** One run: wall time here, CPU and peak RSS from /usr/bin/time. */
function measure(cmd, c) {
  const outFile = path.join(os.tmpdir(), `detangle-bench-${process.pid}.out`);
  const fd = fs.openSync(outFile, "w");
  const t = performance.now();
  const r = spawnSync("/usr/bin/time", [...timeArgs, ...cmd], {
    cwd: c.root,
    stdio: ["ignore", fd, "pipe"],
    env: { ...process.env, BENCH_TSCONFIG: c.tsconfig, NODE_OPTIONS: "--max-old-space-size=8192" },
    maxBuffer: 1 << 30,
  });
  const wall = (performance.now() - t) / 1000;
  fs.closeSync(fd);
  const err = r.stderr.toString();
  let cpu, rss, cycles;
  if (mac) {
    const m = err.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
    cpu = m && Number(m[2]) + Number(m[3]);
    rss = Number(err.match(/(\d+)\s+maximum resident set size/)?.[1]) / 2 ** 20;
    cycles = Number(err.match(/(\d+)\s+cycles elapsed/)?.[1]) || null;
  } else {
    const m = err.match(/BENCH ([\d.]+) ([\d.]+) ([\d.]+) (\d+)/);
    cpu = m && Number(m[2]) + Number(m[3]);
    rss = m && Number(m[4]) / 1024;
    cycles = null;
  }
  return { wall, cpu, rss, cycles, status: r.status, stderr: err, out: outFile };
}

const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

// ---------------------------------------------------------------- preflight

// Numbers are only worth keeping from a quiet machine: on battery, macOS
// throttles (one run was ~6x slow); a busy app or system jobs catching up
// after waking take cores (detangle 0.259 s instead of 0.175 s). So before
// measuring, check power, load and the top CPU users, and wait for them to
// clear. BENCH_PREFLIGHT_LOAD and BENCH_PREFLIGHT_CPU change the thresholds.
const LOAD_MAX = Number(process.env.BENCH_PREFLIGHT_LOAD ?? 2.5);
const CPU_MAX = Number(process.env.BENCH_PREFLIGHT_CPU ?? 30);
const RECHECK_S = 10;
const WAIT_S = 5 * 60;

/** "AC", "battery", or null where it can't tell (or there's no battery). */
function power() {
  try {
    if (mac) {
      const out = execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" });
      return /'Battery Power'/.test(out) ? "battery" : /'AC Power'/.test(out) ? "AC" : null;
    }
    if (process.platform === "linux") {
      const dir = "/sys/class/power_supply";
      const read = (s, f) => fs.readFileSync(path.join(dir, s, f), "utf8").trim();
      const mains = fs.readdirSync(dir).filter((s) => { try { return read(s, "type") === "Mains"; } catch { return false; } });
      if (!mains.length) return null;
      return mains.some((s) => read(s, "online") === "1") ? "AC" : "battery";
    }
  } catch {}
  return null;
}

/** Processes by CPU use, most first, apart from this one and its children. */
function topProcesses() {
  if (!mac && process.platform !== "linux") return [];
  let out;
  try {
    out = mac
      ? execFileSync("ps", ["-Ao", "pid=,ppid=,pcpu=,comm=", "-r"], { encoding: "utf8" })
      : execFileSync("ps", ["-eo", "pid=,ppid=,pcpu=,comm=", "--sort=-pcpu"], { encoding: "utf8" });
  } catch {
    return [];
  }
  const procs = out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)).filter(Boolean)
    .map(([, pid, ppid, pcpu, comm]) => ({ pid: Number(pid), ppid: Number(ppid), pcpu: Number(pcpu), comm }));
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const ours = (pid) => {
    for (let i = 0; pid > 1 && i < 64; i++, pid = parent.get(pid)) if (pid === process.pid) return true;
    return false;
  };
  return procs.filter((p) => !ours(p.pid)).map((p) => ({ name: displayName(p.comm), pcpu: p.pcpu, system: systemProcess(p.comm) }));
}

// macOS's comm is the executable's path: name an app by its outermost .app
// ("Perplexity", not "Perplexity Helper (Renderer)"), anything else by file.
const displayName = (comm) => comm.match(/([^/]+)\.app\//)?.[1] ?? path.basename(comm);
const systemProcess = (comm) => mac && /^\/(System|usr|sbin|bin|Library\/Apple)\//.test(comm);

function checkConditions() {
  const procs = topProcesses();
  const c = { power: power(), load: Math.round(os.loadavg()[0] * 100) / 100, load_max: LOAD_MAX, top: procs.slice(0, 5) };
  const problems = [];
  if (c.power === "battery") problems.push("on battery power, which throttles the CPU: plug in");
  if (c.load > LOAD_MAX) problems.push(`load average ${c.load.toFixed(2)} (over ${LOAD_MAX}): wait for it to settle`);
  // One line per program: an app's helpers or a build's rustc processes add up.
  const busy = new Map();
  for (const p of procs.filter((p) => p.pcpu > CPU_MAX)) {
    const b = busy.get(p.name) ?? { ...p, pcpu: 0 };
    b.pcpu += p.pcpu;
    busy.set(p.name, b);
  }
  for (const p of busy.values()) {
    problems.push(p.system ? `wait for ${p.name} to settle (${p.pcpu.toFixed(0)}% CPU)` : `quit ${p.name} (${p.pcpu.toFixed(0)}% CPU)`);
  }
  return { ...c, problems };
}

async function preflight() {
  const start = Date.now();
  let c = checkConditions();
  if (c.problems.length && force) {
    console.error(`warning: measuring anyway (--force); the machine isn't quiet:\n${c.problems.map((p) => `  - ${p}`).join("\n")}`);
  } else if (c.problems.length) {
    console.error(`The machine isn't quiet enough to measure:\n${c.problems.map((p) => `  - ${p}`).join("\n")}`);
    console.error(`Checking again every ${RECHECK_S} s for up to ${WAIT_S / 60} minutes (--force to measure anyway).`);
    while (c.problems.length) {
      if (Date.now() - start >= WAIT_S * 1000) {
        console.error(`Still not quiet after ${WAIT_S / 60} minutes:\n${c.problems.map((p) => `  - ${p}`).join("\n")}`);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, RECHECK_S * 1000));
      c = checkConditions();
      const waited = Math.round((Date.now() - start) / 1000);
      console.error(c.problems.length ? `  ${waited} s: ${c.problems.join("; ")}` : `  ${waited} s: quiet now`);
    }
  }
  const { power: pw, load, load_max, top, problems } = c;
  return { at: new Date().toISOString(), power: pw, load, load_max, top: top.map(({ name, pcpu }) => ({ name, pcpu })), problems, forced: force && problems.length > 0, waited_s: Math.round((Date.now() - start) / 1000) };
}

// ---------------------------------------------------------------- run

const machine = `${os.cpus()[0].model.trim()} (${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.type()} ${os.release()}), Node ${process.version}`;
console.error(`machine: ${machine}`);
const results = { repos: {}, machine, date: new Date().toISOString().slice(0, 10), versions: versions() };

// Clone and install first, so their work is done before the preflight.
for (const name of only) if (!corpora[name]) throw new Error(`unknown corpus ${name}; see corpora.json`);
const prepared = Object.fromEntries(only.map((name) => [name, prepare(name)]));
const conditions = await preflight();
console.error(`conditions: power ${conditions.power ?? "unknown"}, load ${conditions.load}, top ${conditions.top.map((p) => `${p.name} ${p.pcpu}%`).join(", ") || "unknown"}${conditions.forced ? " (forced)" : ""}`);
results.conditions = [{ ...conditions, corpora: only, tools: tools.map((t) => t.name) }];

for (const name of only) {
  const c = prepared[name];
  const rows = [];
  for (const tool of tools) {
    const big = name === "vscode";
    const runs = runsOverride ?? (tool.slow && big ? 1 : tool.runs);
    const cache = tool.cache ? fs.mkdtempSync(path.join(os.tmpdir(), "detangle-bench-cache-")) : undefined;
    const cmd = tool.cmd(c, cache);
    // A warm-up run fills the OS file cache (and a tool's own cache).
    const warm = measure(cmd, c);
    let found;
    try {
      found = tool.found(fs.readFileSync(warm.out, "utf8"));
    } catch (e) {
      throw new Error(`${tool.name} on ${name} (exit ${warm.status}): ${e.message}\n${warm.stderr.slice(-2000)}`);
    }
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(measure(cmd, c));
    const row = {
      name: tool.name,
      wall: median(samples.map((s) => s.wall)),
      cpu: median(samples.map((s) => s.cpu)),
      cycles: median(samples.map((s) => s.cycles)),
      rss_mb: median(samples.map((s) => s.rss)),
      runs,
      found,
    };
    rows.push(row);
    console.error(`  ${name} · ${tool.name}: ${row.wall.toFixed(3)} s, ${row.rss_mb.toFixed(0)} MB (${runs} runs) · found ${JSON.stringify(found)}`);
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  }
  results.repos[name] = { label: c.label, commit: c.commit, tools: rows };
}

// Merge into the day's file for this platform: runs of different corpora
// or tools add up; a tool measured again replaces its row.
fs.mkdirSync(path.join(here, "results"), { recursive: true });
const file = path.join(here, "results", `${results.date}-${os.platform()}-${os.arch()}.json`);
if (fs.existsSync(file)) {
  const before = JSON.parse(fs.readFileSync(file, "utf8"));
  // Each run's conditions are kept, in order, with what it measured.
  results.conditions = [...(before.conditions ?? []), ...results.conditions];
  for (const [name, r] of Object.entries(before.repos)) {
    const now = results.repos[name];
    if (!now) results.repos[name] = r;
    else now.tools = [...r.tools.filter((t) => !now.tools.some((n) => n.name === t.name)), ...now.tools];
  }
}
fs.writeFileSync(file, JSON.stringify(results, null, 2) + "\n");

console.log(`\n${machine}\n`);
for (const [name, r] of Object.entries(results.repos)) {
  console.log(`### ${r.label} (${r.commit.slice(0, 10)})\n`);
  console.log("| Tool | Wall (median) | CPU | Peak memory | Runs | Found |");
  console.log("| ---- | ------------- | --- | ----------- | ---- | ----- |");
  for (const t of r.tools) {
    const found = Object.entries(t.found).map(([k, v]) => `${k}: ${v}`).join(", ");
    console.log(`| ${t.name} | ${t.wall.toFixed(3)} s | ${t.cpu?.toFixed(2) ?? "?"} s | ${t.rss_mb?.toFixed(0) ?? "?"} MB | ${t.runs} | ${found} |`);
  }
  console.log();
}
console.log(`results: ${path.relative(here, file)}`);

function versions() {
  const lock = JSON.parse(fs.readFileSync(path.join(here, "package-lock.json"), "utf8")).packages;
  const v = (p) => lock[`node_modules/${p}`]?.version;
  return Object.fromEntries(["detangle", "dependency-cruiser", "madge", "oxlint", "eslint", "eslint-plugin-import", "eslint-import-resolver-typescript", "typescript"].map((p) => [p, v(p)]));
}
