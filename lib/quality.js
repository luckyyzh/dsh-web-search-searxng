// Pure query-tuning and result-quality helpers for the SearXNG search provider.
// No runtime dependencies: everything here is plain JS so it can be unit-tested
// with bare node (`node test/smoke.mjs`).

/* ------------------------------------------------------------------ */
/* HTML entity decoding                                                */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", middot: "·", bull: "•", trade: "™",
  reg: "®", copy: "©", deg: "°", times: "×",
};

/** Decode named and numeric HTML entities (SearXNG leaves them in titles/snippets). */
export function decodeEntities(input) {
  if (typeof input !== "string" || input.indexOf("&") === -1) return input ?? "";
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === "#") {
      try {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      } catch { /* fall through */ }
      return match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

/* ------------------------------------------------------------------ */
/* URL normalization: redirect unwrapping + tracking-param stripping   */
/* ------------------------------------------------------------------ */

const TRACKING_PARAM = /^(utm_|ga_|_ga$|gbraid$|wbraid$|gclid$|gclsrc$|dclid$|fbclid$|fb_action_ids$|msclkid$|mc_cid$|mc_eid$|igshid$|spm$|scm$|share_?id$|share_?from$|from(_?singlepage|-group)?$|isappinstalled$|scene$|st_?paa_?tag$|clicktime$|start_time$|stdinfo$|wxshare$|refer$|refer_?url$|srcid$|sh_share_?sd$|utm_medium$)/i;

function tryDecodeUrl(value) {
  if (typeof value !== "string") return undefined;
  let candidate = value;
  try { candidate = decodeURIComponent(candidate); } catch { /* keep raw */ }
  return /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

/** Base64url-decode a Bing `u=a1<base64>` redirect payload. */
function unwrapBing(param) {
  if (typeof param !== "string" || !param.startsWith("a1")) return undefined;
  try {
    const decoded = Buffer.from(param.slice(2), "base64url").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : undefined;
  } catch { return undefined; }
}

/**
 * Resolve aggregator/redirector URLs to the real target.
 * Handles: DuckDuckGo /l/?uddg=, Google /url?q=, Bing /ck/a?u=a1…,
 * and a conservative generic `url|target|redirect` parameter pass-through.
 */
export function unwrapRedirect(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return rawUrl; }
  const host = url.hostname.toLowerCase();
  try {
    if (/(^|\.)duckduckgo\.com$/.test(host) && url.pathname.startsWith("/l/")) {
      const target = tryDecodeUrl(url.searchParams.get("uddg"));
      if (target) return target;
    }
    if (/(^|\.)google(\.[a-z.]{2,})?$/.test(host) && (url.pathname === "/url" || url.pathname === "/imgres")) {
      const target = tryDecodeUrl(url.searchParams.get("q") ?? url.searchParams.get("url"));
      if (target) return target;
    }
    if (/(^|\.)bing\.com$/.test(host) && url.pathname === "/ck/a") {
      const target = unwrapBing(url.searchParams.get("u"));
      if (target) return target;
    }
    if (/(^|\.)yandex(\.[a-z.]{2,})?$/.test(host) && /\/(clck|search\.yandex)/.test(url.pathname)) {
      const target = tryDecodeUrl(url.searchParams.get("url") ?? url.searchParams.get("tu"));
      if (target) return target;
    }
    // Generic redirect parameters — only when the parameter itself is a full URL.
    if (!/(^|\.)(google|bing|duckduckgo|baidu|sogou|so\.com|quark|bingx)\./i.test(host)) {
      for (const key of ["url", "target", "redirect_url", "redirect_uri", "dest", "goto"]) {
        const target = tryDecodeUrl(url.searchParams.get(key));
        if (target && target !== rawUrl) return target;
      }
    }
  } catch { /* fall back to the original URL */ }
  return rawUrl;
}

/** Unwrap redirects, strip fragments + tracking params, canonicalize host. */
export function normalizeUrl(rawUrl) {
  const unwrapped = unwrapRedirect(rawUrl);
  let url;
  try { url = new URL(unwrapped); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  // Drop empty search (?), keep real query strings.
  let out = url.toString();
  if (url.searchParams.size === 0) out = out.replace(/\?$/, "");
  return out.replace(/\/$/, "");
}

/* ------------------------------------------------------------------ */
/* Query tuning: language + time_range inference                       */
/* ------------------------------------------------------------------ */

const CJK = /[\u3400-\u9fff\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/;

const DAY_RE = /(今天|今日|本日|today|just in|breaking|突发|刚刚)/i;
const WEEK_RE = /(本周|这周|这一周|过去一周|上周|最近一周|this week|last week|past week)/i;
const MONTH_RE = /(本月|这个月|上个月|近一个月|最近一个月|this month|last month|past month)/i;
// Only relative recency cues — a *specific* year mention ("2023年 GDP") is not
// a recency signal and must not get filtered to the past 365 days.
const YEAR_RE = /(今年|这一年|this year|最近|近期|最新的|最新|latest|recent|recently|newest|新闻|资讯|news|更新|发布了|released)/i;

/** Infer a SearXNG time_range (day/week/month/year) from recency cues in the query. */
export function inferTimeRange(query) {
  if (DAY_RE.test(query)) return "day";
  if (WEEK_RE.test(query)) return "week";
  if (MONTH_RE.test(query)) return "month";
  if (YEAR_RE.test(query)) return "year";
  return undefined;
}

/** Infer a SearXNG language code: CJK queries get zh-CN, everything else "all". */
export function inferLanguage(query) {
  return CJK.test(query) ? "zh-CN" : "all";
}

/* ------------------------------------------------------------------ */
/* Reranking: engine-weighted RRF + query-term relevance               */
/* ------------------------------------------------------------------ */

// Engines differ a lot in result quality for LLM consumption; weights nudge
// the Reciprocal-Rank-Fusion score without hard-filtering anything.
const ENGINE_WEIGHTS = {
  wikipedia: 1.35, "wikipedia zh": 1.35, "zh wikipedia": 1.35,
  google: 1.2, "google news": 1.15, startpage: 1.15, brave: 1.15,
  duckduckgo: 1.05, "duckduckgo images": 0.8, bing: 1.0, "bing news": 0.95,
  mojeek: 0.95, ecosia: 0.95, qwant: 0.9, yandex: 0.9,
  sogou: 0.9, "sogou news": 0.9, quark: 0.85, "360search": 0.8, "360 news": 0.8,
  baidu: 0.75, "quark wiki": 0.8,
};

function engineWeight(engine) {
  if (typeof engine !== "string") return 0.9;
  const key = engine.toLowerCase().trim();
  if (ENGINE_WEIGHTS[key] !== undefined) return ENGINE_WEIGHTS[key];
  for (const [name, weight] of Object.entries(ENGINE_WEIGHTS)) {
    if (key.startsWith(name)) return weight;
  }
  return 0.9;
}

/** Tokenize for relevance scoring: latin words (≥2 chars) + CJK bigrams. */
export function tokenize(text) {
  const lowered = String(text ?? "").toLowerCase();
  const tokens = new Set();
  for (const match of lowered.matchAll(/[a-z0-9][a-z0-9._+#-]{1,}/g)) tokens.add(match[0]);
  const cjkRuns = lowered.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
    if (run.length === 1) tokens.add(run);
  }
  return tokens;
}

function termOverlap(queryTokens, ...fields) {
  if (queryTokens.size === 0) return 0;
  let overlap = 0;
  const [title, body] = fields;
  for (const token of queryTokens) {
    if (title.includes(token)) overlap += 2;
    else if (body.includes(token)) overlap += 1;
  }
  return overlap;
}

/**
 * Rerank SearXNG results: per-engine RRF with engine-quality weights,
 * a SearXNG `score` bonus when present, and a query-term relevance bonus.
 * Returns a new array sorted best-first.
 */
export function rerankResults(results, query) {
  const queryTokens = tokenize(query);
  const rankByEngine = new Map();
  const scored = results.map((item, index) => {
    const engine = typeof item.engine === "string" ? item.engine : "unknown";
    const rank = rankByEngine.get(engine) ?? 0;
    rankByEngine.set(engine, rank + 1);
    const weight = engineWeight(engine);
    let score = (weight * 100) / (60 + rank);
    if (typeof item.score === "number" && Number.isFinite(item.score)) {
      score += Math.max(0, Math.min(1, item.score)) * 0.8;
    }
    if (queryTokens.size > 0) {
      const title = String(item.title ?? "").toLowerCase();
      const body = String(item.content ?? item.snippet ?? "").toLowerCase();
      score += Math.min(termOverlap(queryTokens, title, body), 8) * 0.22;
    }
    return { item, score, index };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map((entry) => entry.item);
}

/* ------------------------------------------------------------------ */
/* Dedup + per-domain cap + final projection to the seam source shape  */
/* ------------------------------------------------------------------ */

function registrableHost(url) {
  const host = url.hostname;
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/**
 * Finalize a SearXNG `/search` JSON payload into the DSH seam shape:
 * `{ answer, sources: [{url,title,snippet,publishedAt}] }` with
 * dedup, per-domain caps, entity decoding and reranking applied.
 */
export function finalizeResults(data, query, options = {}) {
  const maxPerDomain = options.maxPerDomain ?? 2;
  const snippetLimit = options.snippetLimit ?? 320;
  const raw = Array.isArray(data?.results) ? data.results : [];

  // 1. normalize + unwrap + decode
  const prepared = [];
  for (const item of raw) {
    if (!item || typeof item.url !== "string") continue;
    const url = normalizeUrl(item.url);
    if (!url) continue;
    prepared.push({
      url,
      title: decodeEntities(String(item.title ?? "")).trim(),
      content: decodeEntities(String(item.content ?? "")).trim(),
      engine: item.engine,
      score: item.score,
      publishedDate: typeof item.publishedDate === "string" ? item.publishedDate : undefined,
    });
  }

  // 2. rerank (best-first), then dedup + per-domain cap on the ordered list
  const ordered = options.rerank === false ? prepared : rerankResults(prepared, query);
  const seenUrls = new Set();
  const domainCount = new Map();
  const kept = [];
  for (const item of ordered) {
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    let host;
    try { host = registrableHost(new URL(item.url)); } catch { host = item.url; }
    const used = domainCount.get(host) ?? 0;
    if (used >= maxPerDomain) continue;
    domainCount.set(host, used + 1);
    kept.push(item);
  }

  // 3. project to the seam source shape
  const sources = kept.map((item) => {
    const source = { url: item.url };
    if (item.title) source.title = item.title;
    if (item.content) {
      source.snippet = item.content.length > snippetLimit
        ? `${item.content.slice(0, snippetLimit - 1)}…`
        : item.content;
    }
    if (item.publishedDate) source.publishedAt = item.publishedDate;
    return source;
  });

  // 4. instant answers (SearXNG `answers`) → seam `content`
  let answer;
  if (Array.isArray(data?.answers) && data.answers.length > 0) {
    const parts = data.answers
      .map((entry) => typeof entry === "string"
        ? entry
        : String(entry?.answer ?? entry?.content ?? ""))
      .map((text) => decodeEntities(text).trim())
      .filter((text) => text.length > 0);
    if (parts.length > 0) answer = parts.join("\n");
  }

  return { sources, answer };
}
