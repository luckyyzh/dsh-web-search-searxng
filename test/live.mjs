// Live probe against a real SearXNG instance (read-only GET).
// Usage: SEARXNG_URL=https://your-searxng.example/search-api SEARXNG_TOKEN=… node test/live.mjs "query"
import { finalizeResults, inferLanguage, inferTimeRange } from "../lib/quality.js";

const rawBase = process.env.SEARXNG_URL;
if (!rawBase) {
  console.error("SEARXNG_URL not set (e.g. https://your-searxng.example/search-api)");
  process.exit(2);
}
const baseURL = rawBase.replace(/\/+$/, "");
const token = process.env.SEARXNG_TOKEN;
if (!token) {
  console.error("SEARXNG_TOKEN not set in environment");
  process.exit(2);
}
const query = process.argv[2] || "OpenAI 最新 发布 模型";
const url = new URL(`${baseURL}/search`);
url.searchParams.set("q", query);
url.searchParams.set("format", "json");
url.searchParams.set("pageno", "1");
const language = inferLanguage(query);
if (language) url.searchParams.set("language", language);
const timeRange = inferTimeRange(query);
if (timeRange) url.searchParams.set("time_range", timeRange);

const started = Date.now();
const response = await fetch(url, {
  headers: { accept: "application/json", "x-search-token": token },
  signal: AbortSignal.timeout(20000),
});
console.log(`HTTP ${response.status} in ${Date.now() - started} ms`);
console.log(`inferred: language=${language} time_range=${timeRange ?? "-"}`);
if (!response.ok) {
  console.error((await response.text()).slice(0, 500));
  process.exit(1);
}
const data = await response.json();
console.log(`raw results=${(data.results ?? []).length} answers=${(data.answers ?? []).length} engines_responded=${[...new Set((data.results ?? []).map((r) => r.engine))].join(",")}`);
const { sources, answer } = finalizeResults(data, query, { maxPerDomain: 2 });
console.log(`finalized sources=${sources.length}${answer ? ` answer="${answer.slice(0, 120)}"` : ""}`);
for (const s of sources.slice(0, 8)) {
  console.log(`- [${(s.title ?? "").slice(0, 60)}](${s.url}) ${s.publishedAt ?? ""}`);
  if (s.snippet) console.log(`    ${(s.snippet ?? "").slice(0, 100)}`);
}
