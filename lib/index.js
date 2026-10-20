// DSH search provider plugin: SearXNG (self-hosted meta-search).
//
// Registers a `ctx.web` search provider so the built-in `web_search` tool
// routes through a SearXNG instance. Query tuning (language / time_range),
// redirect unwrapping, dedup, per-domain caps and reranking live in
// ./quality.js and run client-side over the SearXNG JSON response.
//
// Runtime imports are kept minimal on purpose: only `@deepseek-ai/schemastery`
// (present in every profile's node_modules) is imported statically; the rest
// of the integration degrades gracefully when a service is absent, so a
// misconfigured install can never abort DSH startup.

import z from "@deepseek-ai/schemastery";
import { finalizeResults, inferLanguage, inferTimeRange } from "./quality.js";

// `@deepseek-ai/dsh-launch-environment` is imported lazily and optionally: a
// static import that fails to resolve would abort module loading and silently
// kill the plugin, so we resolve it in the background and fall back to
// `process.env` when the service or mapping is unavailable.
let launchModule;
import("@deepseek-ai/dsh-launch-environment")
  .then((m) => { launchModule = m; })
  .catch(() => { /* optional dependency */ });

/** Cordis plugin id — used in `cordis.patch.yml` rows and the settings page. */
export const name = "web-search-searxng";

/** Only the web seam is required; everything else is looked up defensively. */
export const inject = ["web"];

export const Config = z.object({
  /** Base URL of the SearXNG instance; the `/search` endpoint is appended. */
  baseURL: z.string().default("").volatile()
    .description("SearXNG 实例基地址（必填，会自动拼接 /search）"),
  /** Access token sent as the X-Search-Token header. Wins over tokenEnv. */
  token: z.string().role("secret").volatile()
    .description("访问令牌（X-Search-Token 头），优先于环境变量"),
  /** Environment / launch-environment name holding the token. */
  tokenEnv: z.string().default("SEARXNG_TOKEN").volatile()
    .description("存放访问令牌的环境变量名"),
  /** Comma-separated engine list passed to SearXNG (`engines=`). Empty = instance defaults. */
  engines: z.string().default("").volatile()
    .description("指定搜索引擎（逗号分隔，留空用实例默认）"),
  /** Engines used for one degradation retry after failures / empty results. */
  fallbackEngines: z.string().default("bing").volatile()
    .description("降级重试时使用的引擎（失败或零结果时重试一次）"),
  /** Force a SearXNG language code; empty = infer (CJK → zh-CN, else all). */
  language: z.string().default("").volatile()
    .description("强制搜索语言；留空则按查询自动判断"),
  /** Infer time_range (day/week/month/year) from recency cues in the query. */
  autoTimeRange: z.boolean().default(true).volatile()
    .description("根据查询中的时间线索自动设置 time_range"),
  /** Apply client-side reranking + dedup + per-domain caps. */
  rerank: z.boolean().default(true).volatile()
    .description("对结果做重排、去重与同域名限流"),
  /** Max results kept per registrable domain. */
  maxPerDomain: z.number().step(1).min(1).max(10).default(2).volatile()
    .description("同一域名最多保留的结果数"),
  /** Per-request timeout in milliseconds. */
  timeoutMs: z.number().step(1).min(1000).max(120000).default(20000).volatile()
    .description("单次请求超时（毫秒）"),
  /** Delay before the single retry on network errors / 429 / 5xx. */
  retryDelayMs: z.number().step(1).min(0).max(10000).default(1500).volatile()
    .description("重试前的等待（毫秒），仅重试一次"),
  /** Search-response cache TTL; 0 disables caching. */
  cacheTtlMs: z.number().step(1).min(0).max(3600000).default(300000).volatile()
    .description("搜索结果缓存时长（毫秒），0 表示关闭"),
});

const PROVIDER_ID = "searxng";
const CACHE_MAX_ENTRIES = 100;
const MAX_SOURCES = 40;

/* ------------------------------------------------------------------ */
/* Token resolution                                                    */
/* ------------------------------------------------------------------ */

/** Best-effort token lookup against DSH's launch-environment snapshot. */
function readLaunchEnv(ctx, key) {
  try {
    const value = launchModule?.launchEnvironmentOf?.(ctx)?.get(key)?.value;
    if (typeof value === "string" && value.length > 0) return value;
  } catch { /* service absent — fall through */ }
  try {
    const value = process.env?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  } catch { /* no process env */ }
  return undefined;
}

/** Resolve the access token for one request: literal config → env name. */
function resolveToken(ctx, config) {
  if (typeof config.token === "string" && config.token.length > 0) return config.token;
  if (typeof config.tokenEnv === "string" && config.tokenEnv.length > 0) {
    const value = readLaunchEnv(ctx, config.tokenEnv);
    if (value) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function buildSearchUrl(baseURL, params) {
  const url = new URL(`${String(baseURL).replace(/\/+$/, "")}/search`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  if (params.language) url.searchParams.set("language", params.language);
  if (params.timeRange) url.searchParams.set("time_range", params.timeRange);
  if (params.engines) url.searchParams.set("engines", params.engines);
  return url;
}

function isAbort(error, signal) {
  if (signal?.aborted === true) return true;
  const name = error?.name ?? error?.cause?.name;
  return name === "AbortError";
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** Combine a caller signal with a per-attempt timeout, with graceful fallback. */
function attemptSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return { signal: timeout, cleanup() {} };
  try {
    if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([signal, timeout]), cleanup() {} };
  } catch { /* fall through to manual wiring */ }
  const controller = new AbortController();
  const abortNow = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abortNow, { once: true });
  timeout.addEventListener("abort", abortNow, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      signal.removeEventListener("abort", abortNow);
      timeout.removeEventListener("abort", abortNow);
    },
  };
}

/**
 * GET one SearXNG JSON payload with a single retry on network errors,
 * 429 and 5xx. Throws Error on failure (never resolves undefined).
 */
async function fetchSearchJson(url, token, options, signal) {
  const headers = {
    accept: "application/json",
    "user-agent": "Mozilla/5.0 (compatible; dsh-web-search-searxng/0.1)",
  };
  if (token) headers["x-search-token"] = token;
  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) await delay(options.retryDelayMs, signal);
    const wired = attemptSignal(signal, options.timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: wired.signal });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`SearXNG responded HTTP ${response.status}`);
        continue;
      }
      if (!response.ok) {
        const status = response.status;
        // 4xx other than 429 will not heal on retry — fail fast.
        // 403 is most often NOT an auth failure: SearXNG answers 403 whenever
        // `format=json` is not in the instance's `server.formats` allow-list,
        // so point at settings.yml before blaming the token.
        const error = status === 401
          ? new Error(`SearXNG rejected the access token (HTTP 401). Check the plugin's token/tokenEnv config.`)
          : status === 403
            ? new Error("SearXNG refused the request (HTTP 403). If the token is correct, the instance most likely has JSON output disabled: add `json` to `server.formats` in settings.yml and restart SearXNG.")
            : new Error(`SearXNG responded HTTP ${status}`);
        error.nonRetryable = true;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (isAbort(error, signal) || error?.nonRetryable) throw error;
      lastError = error?.name === "TimeoutError"
        ? new Error(`SearXNG request timed out after ${options.timeoutMs} ms`)
        : (error instanceof Error ? error : new Error(String(error)));
    } finally {
      wired.cleanup();
    }
  }
  throw lastError ?? new Error("SearXNG request failed");
}

/* ------------------------------------------------------------------ */
/* Response cache                                                      */
/* ------------------------------------------------------------------ */

const cache = new Map();

function cacheGet(key, ttlMs) {
  if (ttlMs <= 0) return undefined;
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  cache.set(key, { expires: Date.now() + ttlMs, value });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/* ------------------------------------------------------------------ */
/* Search provider                                                     */
/* ------------------------------------------------------------------ */

class SearxngSearchProvider {
  id = PROVIDER_ID;

  /** @param {() => object} options snapshot of config + ctx for one operation */
  constructor(options) {
    this.options = options;
  }

  /** Cheap, local, synchronous: no network, no token validation. */
  available() {
    const config = this.options();
    if (typeof config.baseURL !== "string") return false;
    try { new URL(`${config.baseURL.replace(/\/+$/, "")}/search`); } catch { return false; }
    if (typeof config.token === "string" && config.token.length > 0) return true;
    return typeof config.tokenEnv === "string" && config.tokenEnv.length > 0;
  }

  async search(request, signal) {
    const config = this.options();
    const query = String(request?.query ?? "").trim();
    if (query.length === 0) throw new Error("web-search-searxng: empty query");

    const token = resolveToken(config.ctx ?? {}, config);
    const language = (typeof config.language === "string" && config.language.length > 0)
      ? config.language
      : inferLanguage(query);
    const timeRange = config.autoTimeRange === false ? undefined : inferTimeRange(query);

    const baseParams = { query, language, timeRange };
    const primaryEngines = typeof config.engines === "string" ? config.engines.trim() : "";
    const fallbackEngines = typeof config.fallbackEngines === "string" ? config.fallbackEngines.trim() : "";

    const attempt = async (engines) => {
      const url = buildSearchUrl(config.baseURL, { ...baseParams, engines });
      const cacheKey = url.toString();
      const cached = cacheGet(cacheKey, config.cacheTtlMs);
      if (cached) return cached;
      const data = await fetchSearchJson(url, token, config, signal);
      cacheSet(cacheKey, data, config.cacheTtlMs);
      return data;
    };

    const isUsable = (data) => Array.isArray(data?.results)
      && (data.results.length > 0 || (Array.isArray(data?.answers) && data.answers.length > 0));

    let data;
    let failure;
    try {
      data = await attempt(primaryEngines);
      const needsFallback = !isUsable(data)
        && fallbackEngines.length > 0
        && normalizeEngineSet(fallbackEngines) !== normalizeEngineSet(primaryEngines);
      if (needsFallback) {
        try {
          const retry = await attempt(fallbackEngines);
          if (isUsable(retry) || !isUsable(data)) data = retry;
        } catch (error) {
          if (isAbort(error, signal)) throw error;
          if (!isUsable(data)) failure = error;
        }
      }
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      failure = error;
      // One degradation pass: timeout / engine trouble → try the fallback engines.
      if (fallbackEngines.length > 0 && normalizeEngineSet(fallbackEngines) !== normalizeEngineSet(primaryEngines)) {
        try {
          data = await attempt(fallbackEngines);
          failure = undefined;
        } catch (retryError) {
          if (isAbort(retryError, signal)) throw retryError;
          failure = retryError;
        }
      }
    }

    if (!data) {
      throw failure ?? new Error("web-search-searxng: no response");
    }

    const { sources, answer } = finalizeResults(data, query, {
      rerank: config.rerank !== false,
      maxPerDomain: config.maxPerDomain ?? 2,
    });
    const capped = sources.slice(0, MAX_SOURCES);
    const result = { sources: capped, truncated: false };
    if (answer) result.content = answer;
    return result;
  }
}

function normalizeEngineSet(engines) {
  return String(engines ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).sort().join(",");
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

function snapshotConfig(ctx, config) {
  // Lazy: each call re-reads the volatile config so settings changes apply
  // without a restart, while one search still sees a consistent snapshot.
  return () => ({
    ctx,
    baseURL: config.baseURL.get(),
    token: config.token.get(),
    tokenEnv: config.tokenEnv.get(),
    engines: config.engines.get(),
    fallbackEngines: config.fallbackEngines.get(),
    language: config.language.get(),
    autoTimeRange: config.autoTimeRange.get(),
    rerank: config.rerank.get(),
    maxPerDomain: config.maxPerDomain.get(),
    timeoutMs: config.timeoutMs.get(),
    retryDelayMs: config.retryDelayMs.get(),
    cacheTtlMs: config.cacheTtlMs.get(),
  });
}

export function apply(ctx, config) {
  const provider = new SearxngSearchProvider(snapshotConfig(ctx, config));
  // Registration is an effect scoped to this plugin's fiber; cordis disposes it
  // automatically — like the official providers, there is nothing to unwind here.
  ctx.web.registerSearchProvider(provider);
  ctx.logger?.("web-search-searxng")?.info?.(`registered provider "${PROVIDER_ID}" -> ${config.baseURL.get()}`);
}

// NOTE: deliberately NO default export — the DSH loader takes `module.default`
// as the whole plugin when present, which drops the named `name` / `inject` /
// `Config` metadata (symptom: "cannot get property \"web\" without inject").
// The official providers export only named bindings.
