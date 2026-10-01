# detangle-bench

Reproducible benchmarks for [detangle](https://github.com/debug-diary-1/detangle) against other JavaScript dependency tools, on real repositories at pinned commits.

```sh
git clone https://github.com/debug-diary-1/detangle-bench && cd detangle-bench
npm ci
node bench.mjs                          # everything (~20 minutes, mostly ESLint on VS Code)
node bench.mjs --corpus excalidraw      # one repository
node bench.mjs --tools detangle         # one tool (prefix match)
node bench.mjs --runs 10                # runs per tool, instead of the defaults
```

The first run clones the repositories into `corpora/` and installs their npm dependencies (without install scripts), so imports of packages resolve for every tool. It prints a Markdown table and writes `results/<date>-<os>-<arch>.json`.

## What each tool checks

Each tool looks for the problems it's built to find, on the same files, resolving TypeScript through the same tsconfig:

| Tool | Version | Command |
| ---- | ------- | ------- |
| detangle | 0.2.0 | `detangle check <dir> -f json`: its default rules (cycles, unresolvable imports, undeclared packages, orphans) |
| dependency-cruiser | 18.4.0 | `depcruise <dir> --config configs/dependency-cruiser.cjs -T json`: cycles, orphans and unresolvable imports |
| madge | 8.0.0 | `madge --circular --extensions ts,tsx --ts-config <tsconfig> --json <dir>` |
| ESLint + eslint-plugin-import | 9.39.5 + 2.32.0 | `eslint --config configs/eslint.config.cjs --no-inline-config <dir>`: `import/no-cycle`, TypeScript resolver 4.4.5 |

"Cached" rows run the same command with the tool's own cache warm and nothing changed (`--cache` for detangle and dependency-cruiser).

| Repository | Commit | Directory |
| ---------- | ------ | --------- |
| VS Code | `43dd9070f7` | `src/` |
| Excalidraw | `afed9e6e27` | the whole repository |

## Results

Apple M3 Pro (12 cores, 36 GB, macOS), Node 24, background apps paused, 2026-10-01; raw data in [`results/2026-10-01-darwin-arm64.json`](results/2026-10-01-darwin-arm64.json).

**VS Code** (`43dd9070f7`)

| Tool | Wall time (median) | CPU | Peak memory |
| ---- | ---- | --- | ---- |
| detangle | 0.186 s | 1.72 s | 167 MB |
| detangle (cached) | 0.086 s | 0.50 s | 127 MB |
| dependency-cruiser | 37.5 s | 41.22 s | 4145 MB |
| dependency-cruiser (cached) | 1.109 s | 1.61 s | 824 MB |
| madge --circular | 33.3 s | 47.96 s | 696 MB |
| ESLint import/no-cycle | 286.7 s | 327.46 s | 3159 MB |

**Excalidraw** (`afed9e6e27`)

| Tool | Wall time (median) | CPU | Peak memory |
| ---- | ---- | --- | ---- |
| detangle | 0.023 s | 0.11 s | 43 MB |
| detangle (cached) | 0.017 s | 0.04 s | 27 MB |
| dependency-cruiser | 1.617 s | 2.33 s | 573 MB |
| dependency-cruiser (cached) | 0.429 s | 0.52 s | 282 MB |
| madge --circular | 3.607 s | 6.16 s | 547 MB |
| ESLint import/no-cycle | 7.659 s | 11.88 s | 819 MB |

## How it measures

- Every run is a fresh process. One warm-up run first fills the OS file cache (and, for cached rows, the tool's cache); it isn't counted.
- Wall time is measured around the process; CPU time (user + system) and peak memory come from `/usr/bin/time` (`-l` on macOS, GNU `time` on Linux).
- detangle is timed as its native binary, from the platform package npm installs. The `detangle` command that npm links (and `npx detangle`) is a small Node.js launcher for that binary, which adds Node's startup, about 25-30 ms on this machine, to every run.
- The table shows medians: 30 runs for detangle, 5 for dependency-cruiser, 3 for madge and ESLint, and 1 for ESLint on VS Code, which takes minutes.
- **Run it on a quiet machine.** Background work (a sync client, a browser, an indexer) moves the numbers by tens of percent; detangle's sub-second runs are the most sensitive. The machine is printed with the results.

## What "found" means

The table lists what each tool reported, in its own units, so the counts don't line up one to one:

- **Cycles.** detangle and dependency-cruiser both report each import that lies on a cycle. But detangle by default leaves out cycles that only close through type-only imports (`import type`, which disappears at compile time), while this dependency-cruiser setup follows them; `parity.mjs` compares the two like for like. madge lists cycles (paths), and ESLint's `import/no-cycle` reports imports that lead back to their file within its depth limit.
- **Unresolvable imports and orphans** are comparable one to one; differences come from how each tool resolves edge cases.

## Correctness: which imports are on cycles

```sh
node parity.mjs excalidraw    # after bench.mjs has cloned it
```

`parity.mjs` runs dependency-cruiser and detangle on one corpus and compares the imports each reports on cycles, one by one. detangle runs twice: with its defaults, and with type-only imports counted (`cycles_ignore_type_only = false`), the like-for-like setting. Every import only one tool reports is then checked against dependency-cruiser's own dependency graph.

Results, 2026-10-01:

| | VS Code `src/` | Excalidraw |
| - | - | - |
| dependency-cruiser | 1,303 | 1,638 |
| detangle, defaults (type-only imports make no cycle) | 1,675 | 508 |
| detangle, counting type-only imports | 1,945 | 2,114 |
| Like for like: only dependency-cruiser reports | **0** | **0** |
| Like for like: only detangle reports | 642 | 476 |
| … marked circular in dependency-cruiser's own graph, but not reported | 512 | 271 |
| … not marked circular, though its own graph has a path back | 130 | 205 |

On both, like for like, detangle reports **every** import dependency-cruiser reports, and each import only detangle reports is **on a cycle in dependency-cruiser's own dependency graph**.

## License

MIT or Apache-2.0, at your option.
