# dsh-web-search-searxng

[English](./README.en.md)

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 SearXNG 搜索源插件：把 `web_search` 工具接到自建 SearXNG 实例，并在客户端做一轮质量清洗。格式参照 [pi-web-extensions 的 searxng-search](https://github.com/luckyyzh/pi-web-extensions/tree/main/searxng-search)，按 DSH 的 `ctx.web.registerSearchProvider` 插件规范重写。

## 特性

- **零侵入**：只注册搜索 provider（id：`searxng`），复用内置 `web_search` 工具与 UI；`web_fetch` 仍走内置 fetch。
- **结果清洗**（`lib/quality.js`）：
  - 还原 DDG `uddg` / Google `/url?q=` / Bing `/ck/a` 等重定向链接；
  - 解码 HTML 实体、剥离 `utm_*` 等跟踪参数、去 hash/www；
  - 跨引擎 URL 去重 + 同（注册）域名限流（默认 ≤2 条）；
  - 引擎权重 RRF 重排（wikipedia/google 加权，baidu 降权）+ 查询词相关性加成；
  - SearXNG 即时答案（`answers`）透传为工具输出的 `content`。
- **查询推断**：CJK 查询自动 `language=zh-CN`；"最新/最近/news/突发…" 等时间线索映射 `time_range`（具体年份如"2023年"不会被误判为近期）。
- **稳健性**：单请求超时（默认 20s）、网络错误/429/5xx 单次退避重试、401/403 快速失败、失败或零结果时用 `fallbackEngines`（默认 bing）降级一次、5 分钟响应缓存。

## 服务端契约

`GET {baseURL}/search?q=&format=json&pageno=1[&language=&time_range=&engines=]`，鉴权头 `X-Search-Token`。

## 配置（cordis.patch.yml `config:`，均可在运行期热改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | （必填） | SearXNG 基地址（自动拼 `/search`），如 `https://searxng.example.com/search-api` |
| `token` | 空 | 访问令牌，优先于 `tokenEnv` |
| `tokenEnv` | `SEARXNG_TOKEN` | 令牌所在环境变量名（支持 DSH launch-environment 快照） |
| `engines` | 空 | 指定引擎（逗号分隔），空=实例默认 |
| `fallbackEngines` | `bing` | 失败/零结果时的降级引擎 |
| `language` | 空 | 强制语言；空=按查询推断 |
| `autoTimeRange` | `true` | 按查询推断 `time_range` |
| `rerank` | `true` | 客户端重排/去重/域名限流 |
| `maxPerDomain` | `2` | 同域名最多保留条数 |
| `timeoutMs` / `retryDelayMs` / `cacheTtlMs` | `20000` / `1500` / `300000` | 超时 / 重试等待 / 缓存 |

## 安装

### 方式一：dsh 命令（推荐）

```powershell
dsh plugin add github:luckyyzh/dsh-web-search-searxng
# 发布到 npm 后：
dsh plugin add dsh-web-search-searxng
```

多 profile 时加 `--profile desktop`（或 `web`/`headless`）。然后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加配置行（`baseURL` 必填）：

```yaml
- id: web-search-searxng
  name: dsh-web-search-searxng
  config:
    baseURL: https://searxng.example.com/search-api   # 你的 SearXNG 实例
    tokenEnv: SEARXNG_TOKEN
```

并固定 provider（存在其他可用搜索源时必需，否则报 `WEB_PROVIDER_AMBIGUOUS`）：

```yaml
- id: web
  config:
    searchProvider: searxng
```

确保 `SEARXNG_TOKEN` 在启动 DSH 的环境中可见（用户级环境变量即可），重启 DSH 后新会话 `web_search` 即走 SearXNG。

### 方式二：手动目录安装

1. 把本目录复制到 profile 的 node_modules：

   ```powershell
   Copy-Item -Recurse dsh-web-search-searxng `
     "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-web-search-searxng"
   ```

2. 在 `~/.dsh/profiles/desktop/package.json` 登记（**两处都要**，缺 bundles 插件不会被加载）：

   ```jsonc
   "dependencies": {
     "dsh-web-search-searxng": "file:../path/to/dsh-web-search-searxng" // 发布到 npm 后写版本号
   },
   "dsh": { "profile": { "bundles": [ /* …已有 bundles… */, "dsh-web-search-searxng" ] } }
   ```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加注册行（`baseURL` 必填）：

   ```yaml
   - id: web-search-searxng
     name: dsh-web-search-searxng
     config:
       baseURL: https://searxng.example.com/search-api   # 你的 SearXNG 实例
       tokenEnv: SEARXNG_TOKEN
   ```

4. 配置与 provider 固定：同方式一的配置行与 `searchProvider` pin（`- id: web` 那段），或环境变量 `DSH_WEB_SEARCH_PROVIDER=searxng`；也可在 GUI 的 Web 搜索设置里选。

5. 确保 `SEARXNG_TOKEN` 在启动 DSH 的环境中可见，重启 DSH，新会话里调用 `web_search` 验证。

> ⚠️ 插件加载失败会阻断 DSH 启动；升级后先用 `node --check lib/index.js` + `npm test` 自检。

## 开发

```powershell
npm test          # quality.js 单元测试（离线）
$env:SEARXNG_URL='https://your-searxng.example/search-api'; $env:SEARXNG_TOKEN='…'; node test/live.mjs "查询词"   # 真实端点探测
```

## DSH 插件开发踩坑记录（本插件实测）

- **必须登记到 profile `package.json` 的 `dsh.profile.bundles`**：`cordis.patch.yml` 的行只是配置/注册元数据，不触发插件发现。
- **禁止 `export default`**：loader 会把 `module.default` 整个当作插件，丢掉具名导出的 `name`/`inject`/`Config`（症状：`cannot get property "web" without inject`）。官方 provider 均只用具名导出。
- **cordis 没有 `ctx.onDispose`**：注册 effect 自动随插件 fiber 释放，apply 里无需（也不能）手动清理；注册之后再抛错会回滚本次注册。
- **`@deepseek-ai/*` 静态导入要克制**：profile 插件能解析到 asar 内置包，但解析失败会静默杀死插件加载——非必需的服务改用动态 `import()` + 兜底。
- **配置 `web` seam 的 patch 行 id 是 `web`**（不是 `@deepseek-ai/dsh-web`），`searchProvider` 填 provider 的 `id`（本插件为 `searxng`）。
