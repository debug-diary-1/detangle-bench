#!/usr/bin/env node
// Inject a benchmark results file into the detangle site's embedded bench data.
// Usage: node site.mjs <results.json> <site/index.html> [--size "456 modules, 2,057 imports"]
// --size is required for a repo key the site does not have yet; otherwise the old size is kept.
import { readFileSync, writeFileSync } from 'node:fs';

// Names as shown on the site; kept here so they never appear in the site repo's tooling.
const SITE_NAMES = {
  'dependency-cruiser': 'JavaScript rules tool',
  'dependency-cruiser (cached)': 'JavaScript rules tool (cached)',
};

const args = process.argv.slice(2);
let size;
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--size') size = args[++i];
  else pos.push(args[i]);
}
if (pos.length !== 2) {
  console.error('usage: node site.mjs <results.json> <site/index.html> [--size "N modules, M imports"]');
  process.exit(2);
}
const [resultsPath, sitePath] = pos;

const round = (n, d) => Number(Number(n).toFixed(d));
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const html = readFileSync(sitePath, 'utf8');

const re = /(<script id="bench-data" type="application\/json">)(.*?)(<\/script>)/s;
const m = html.match(re);
if (!m) {
  console.error('bench-data script not found in ' + sitePath);
  process.exit(1);
}
const data = JSON.parse(m[2]);

for (const [key, repo] of Object.entries(results.repos)) {
  const old = data.repos[key];
  const finalSize = size ?? old?.size;
  if (!finalSize) {
    console.error(`new repo "${key}" needs --size "N modules, M imports"`);
    process.exit(1);
  }
  data.repos[key] = {
    label: repo.label,
    size: finalSize,
    tools: repo.tools.map((t) => ({
      name: SITE_NAMES[t.name] ?? t.name,
      wall: round(t.wall, 4),
      cpu: round(t.cpu, 2),
      cycles: Math.round(t.cycles),
      rss_mb: round(t.rss_mb, 1),
    })),
  };
}

// rss_mb is always shown with one decimal (JSON.stringify drops a trailing ".0").
const json = JSON.stringify(data)
  .replace(/"rss_mb":(\d+)(?=[,}])/g, "\"rss_mb\":$1.0")
  .replace(/\//g, "\\/");
if (json.includes('</script>')) {
  console.error('refusing to write: JSON contains </script>');
  process.exit(1);
}
writeFileSync(sitePath, html.replace(re, (_, a, _b, c) => a + json + c));
console.log(`updated ${Object.keys(results.repos).join(', ')} in ${sitePath}`);
