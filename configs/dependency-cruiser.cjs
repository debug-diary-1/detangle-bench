// dependency-cruiser in the benchmark: the problems detangle's default
// rules find that it can check too (cycles, orphans, unresolvable imports),
// resolving TypeScript the same way (the corpus's tsconfig, `exports`).
// bench.mjs sets BENCH_TSCONFIG.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "warn", from: {}, to: { circular: true } },
    {
      name: "no-orphans",
      severity: "info",
      from: { orphan: true, pathNot: ["(^|/)\\.[^/]+\\.[cm]?[jt]s$", "\\.d\\.[cm]?ts$", "(^|/)[^/]+\\.config\\.[cm]?[jt]s$"] },
      to: {},
    },
    { name: "not-to-unresolvable", severity: "error", from: {}, to: { couldNotResolve: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: process.env.BENCH_TSCONFIG },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
