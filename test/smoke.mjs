// Smoke test for quality.js — run with: node test/smoke.mjs
import assert from "node:assert/strict";
import {
  decodeEntities,
  normalizeUrl,
  inferTimeRange,
  inferLanguage,
  rerankResults,
  finalizeResults,
} from "../lib/quality.js";

// entities
assert.equal(decodeEntities("OpenAI &amp; Anthropic &#39;war&#39; &#x2014; news"), "OpenAI & Anthropic 'war' — news");

// redirect unwrap: DDG uddg, Google url?q, Bing ck/a base64url
assert.equal(
  normalizeUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc"),
  "https://example.com/page",
);
assert.equal(
  normalizeUrl("https://www.google.com/url?q=https://example.org/a%3Fx%3D1&sa=x"),
  "https://example.org/a?x=1",
);
const bingTarget = "https://target.example/deep?x=1";
const bingB64 = Buffer.from(bingTarget, "utf8").toString("base64url");
assert.equal(normalizeUrl(`https://www.bing.com/ck/a?!&p=1&u=a1${bingB64}&FORM=NRIG`), "https://target.example/deep?x=1");

// tracking params stripped, hash dropped, www lowered
assert.equal(
  normalizeUrl("https://WWW.Example.com/Path/?utm_source=news&id=42#frag"),
  "https://example.com/Path/?id=42",
);
assert.equal(normalizeUrl("https://example.com/x/"), "https://example.com/x");

// inference
assert.equal(inferTimeRange("突发：OpenAI 刚刚发布新模型"), "day");
assert.equal(inferTimeRange("OpenAI 最新进展"), "year");
assert.equal(inferTimeRange("latest news about the election"), "year");
assert.equal(inferTimeRange("2023年 GDP 数据"), undefined, "specific year is not a recency cue");
assert.equal(inferTimeRange("rust async traits"), undefined);
assert.equal(inferLanguage("rust 异步 trait 怎么用"), "zh-CN");
assert.equal(inferLanguage("how to use rust async"), "all");

// finalize: dedup across redirect + canonical, per-domain cap, answers → content
const data = {
  results: [
    { title: "A &amp; B", url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fone.example%2Fpost&rut=abc", content: "first", engine: "duckduckgo", score: 1 },
    { title: "A & B", url: "https://one.example/post?utm_source=x", content: "first dup", engine: "google", score: 1 },
    { title: "T1", url: "https://news.example/1", content: "same domain one", engine: "bing" },
    { title: "T2", url: "https://news.example/2", content: "same domain two", engine: "bing" },
    { title: "T3", url: "https://news.example/3", content: "same domain three capped", engine: "bing" },
    { title: "OpenAI guide", url: "https://en.wikipedia.org/wiki/OpenAI", content: "the openai encyclopedia article", engine: "wikipedia" },
  ],
  answers: ["OpenAI announced X."],
  suggestions: ["openai x"],
};
const { sources, answer } = finalizeResults(data, "openai announcement", { maxPerDomain: 2 });
assert.equal(answer, "OpenAI announced X.");
const urls = sources.map((s) => s.url);
assert.equal(urls.filter((u) => u.includes("one.example")).length, 1, "redirect+canonical deduped");
assert.equal(urls.filter((u) => u.includes("news.example")).length, 2, "per-domain cap 2");
assert.ok(sources.every((s) => s.url && s.title !== undefined));

// rerank: wikipedia article with term overlap should beat a generic bing result
const ranked = rerankResults(
  [
    { title: "Unrelated thing", url: "https://a.example/1", content: "nothing here", engine: "bing" },
    { title: "OpenAI", url: "https://en.wikipedia.org/wiki/OpenAI", content: "OpenAI, Inc. is an open research company", engine: "wikipedia" },
  ],
  "openai company",
);
assert.ok(ranked[0].url.includes("wikipedia.org"), "wikipedia ranks first");

console.log("smoke: all assertions passed");
