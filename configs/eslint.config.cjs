// ESLint in the benchmark: eslint-plugin-import's import/no-cycle with the
// TypeScript resolver, the usual way to find cycles with ESLint. bench.mjs
// sets BENCH_TSCONFIG and runs ESLint in the corpus with --no-inline-config
// (the corpus's own eslint-disable comments name rules not loaded here).
const parser = require("@typescript-eslint/parser");
const importPlugin = require("eslint-plugin-import");

module.exports = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { import: importPlugin },
    settings: {
      "import/parsers": { "@typescript-eslint/parser": [".ts", ".tsx"] },
      "import/resolver": { typescript: { project: process.env.BENCH_TSCONFIG } },
    },
    rules: { "import/no-cycle": "error" },
  },
];
