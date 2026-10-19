# dsh-web-search-searxng

[中文说明](./README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) search-provider plugin that routes the built-in `web_search` tool through your **self-hosted SearXNG** instance, with client-side result polishing. Inspired by [pi-web-extensions/searxng-search](https://github.com/luckyyzh/pi-web-extensions/tree/main/searxng-search), re-implemented on DSH's `ctx.web.registerSearchProvider` seam.

## Features

- **Non-invasive**: registers one search provider (id `searxng`); the built-in `web_search` tool and UI keep working unchanged. `web_fetch` is untouched.
- **Result polishing** (`lib/quality.js`):
  - unwraps redirect links (DDG `uddg`, Google `/url?q=`, Bing `/ck/a`, …);
  - decodes HTML entities, strips `utm_*` and other tracking params, hashes, `www.`;
  - cross-engine URL dedup + per-domain caps (default ≤2 results/domain);
  - engine-weighted Reciprocal-Rank-Fusion reranking (wikipedia/google boosted, baidu dampened) with query-term relevance bonus;
  - SearXNG instant answers (`answers`) pass through as the tool's `content`.
- **Query tuning**: CJK queries get `language=zh-CN`; recency cues ("最新 / latest / news / 突发"…) map to `time_range` (a specific year like "2023" is deliberately *not* treated as recency).
- **Robustness**: per-request timeout (20 s default), one backoff retry on network errors / 429 / 5xx, fail-fast on 401/403, one degradation retry via `fallbackEngines` (default bing) on failure or empty results, 5-minute response cache.

## Server contract

`GET {baseURL}/search?q=&format=json&pageno=1[&language=&time_range=&engines=]` with the `X-Search-Token` auth header.

## Configuration (cordis.patch.yml `config:`, all hot-reloadable)

| Key | Default | Description |
| --- | --- | --- |
| `baseURL` | *(required)* | Base URL of your SearXNG instance (`/search` appended) |
| `token` | empty | Access token; wins over `tokenEnv` |
| `tokenEnv` | `SEARXNG_TOKEN` | Environment variable holding the token (also reads DSH's launch-environment snapshot) |
| `engines` | empty | Comma-separated engine whitelist; empty = instance defaults |
| `fallbackEngines` | `bing` | Degradation engines on failure/empty results |
| `language` | empty | Force a SearXNG language code; empty = infer from query |
| `autoTimeRange` | `true` | Infer `time_range` from query recency cues |
| `rerank` | `true` | Client-side rerank / dedup / domain caps |
| `maxPerDomain` | `2` | Max results per registrable domain |
| `timeoutMs` / `retryDelayMs` / `cacheTtlMs` | `20000` / `1500` / `300000` | Timeout / retry delay / cache TTL |

## Install

### Option 1: dsh command (recommended)

**Prerequisites**: DeepSeek Harness installed and the `dsh` command available (`dsh --version` prints a version). If it is not on your PATH, the Windows desktop app ships it at `"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"` (add that `bin` directory to PATH, or use the full path). No-CLI alternative: DSH settings → plugin manager → **Add plugin** and paste `https://github.com/luckyyzh/dsh-web-search-searxng`.

**Step 1 · Install the plugin**

```sh
# from GitHub into the desktop profile (works today)
dsh plugin --profile desktop add github:luckyyzh/dsh-web-search-searxng

# pinned version / npm package name once published
dsh plugin --profile desktop add dsh-web-search-searxng@0.1.0
```

> `--profile` is required (`desktop` / `web` / `headless` …) and must come right after `plugin`, before the package argument. Arguments are forwarded to pnpm, so npm names, `github:owner/repo`, git URLs and absolute local paths all work. Install once per profile you want it on.

**Step 2 · Point it at your instance**

Append to the **end of** `~/.dsh/profiles/desktop/cordis.patch.yml` (use the matching directory for your `--profile`):

```yaml
- id: web-search-searxng
  name: dsh-web-search-searxng
  config:
    baseURL: https://searxng.example.com/search-api   # ← your SearXNG instance (required; empty = provider stays off)
    tokenEnv: SEARXNG_TOKEN                           # env var holding the access token
```

**Step 3 · Provide the access token** (skip if your instance needs no auth)

```powershell
# Windows (user-level; re-login so GUI-launched DSH picks it up)
[Environment]::SetEnvironmentVariable("SEARXNG_TOKEN", "your-token", "User")
```

```sh
# macOS / Linux: export in your shell profile and launch dsh from a terminal,
# or on macOS: launchctl setenv SEARXNG_TOKEN your-token
export SEARXNG_TOKEN="your-token"
```

**Step 4 · Pin the provider** (strongly recommended; required whenever another search provider such as the built-in one is also usable, otherwise `WEB_PROVIDER_AMBIGUOUS`)

Append to the same file:

```yaml
- id: web
  config:
    searchProvider: searxng
```

**Step 5 · Restart DSH and verify**

Fully quit and relaunch DSH (plugins load at startup only), then run `web_search` in a new session. Working signs: no `utm_*` tracking params in result URLs, CJK queries returning mostly Chinese sources, at most 2 results per domain.

**Common errors**

| Error | Cause / fix |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | plugin not installed: check `dsh plugin --profile desktop why dsh-web-search-searxng`; verify the patch row's `name: dsh-web-search-searxng` |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | `baseURL` not configured (default empty) or `tokenEnv` names a missing variable |
| `WEB_PROVIDER_AMBIGUOUS` | Step 4 pin missing |
| 401 / `rejected the access token` | wrong or expired token — check against your instance |

### Option 2: manual directory install

1. Copy this directory into your profile's `node_modules`:

   ```powershell
   Copy-Item -Recurse dsh-web-search-searxng `
     "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-web-search-searxng"
   ```

2. Register it in `~/.dsh/profiles/desktop/package.json` — both sections matter:

   ```jsonc
   "dependencies": {
     "dsh-web-search-searxng": "file:../path/to/dsh-web-search-searxng" // or "0.1.0" if published
   },
   "dsh": { "profile": { "bundles": [ /* …existing bundles… */, "dsh-web-search-searxng" ] } }
   ```

3. Add the plugin row and pin the provider in `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - id: web-search-searxng
     name: dsh-web-search-searxng
     config:
       baseURL: https://searxng.example.com/search-api   # your instance
       tokenEnv: SEARXNG_TOKEN
   - id: web
     config:
       searchProvider: searxng
   ```

   Pinning is required whenever another search provider is also usable (otherwise `WEB_PROVIDER_AMBIGUOUS`); alternatively set `DSH_WEB_SEARCH_PROVIDER=searxng`.

4. Make sure `SEARXNG_TOKEN` (or your `tokenEnv` name) is visible to the DSH process, then restart DSH.

> ⚠️ A plugin that throws at startup breaks DSH boot. After edits run `node --check lib/index.js` and `npm test`.

## DSH plugin gotchas learned the hard way

- Third-party plugins load only when listed in the profile `package.json` **`dsh.profile.bundles`** — `cordis.patch.yml` rows alone never trigger discovery.
- **Never `export default`** in a plugin entry: the loader takes `module.default` as the whole plugin, silently dropping the named `name`/`inject`/`Config` metadata (symptom: `cannot get property "web" without inject`). Official providers export named bindings only.
- cordis has **no `ctx.onDispose`**; registration effects are disposed with the plugin fiber automatically. Throwing after registering rolls the registration back.
- Prefer lazy `import()` + fallbacks for optional `@deepseek-ai/*` services: a failed static import kills plugin loading with no visible error.
- The `web` seam's patch row id is `web` (not the package name); `searchProvider` takes the provider id (`searxng`).

## Development

```sh
npm test                                                        # offline unit tests for quality.js
SEARXNG_URL=https://… SEARXNG_TOKEN=… node test/live.mjs "query" # live end-to-end probe
```

## License

MIT
