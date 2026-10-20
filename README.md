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

> ⚠️ **实例必须放行 JSON 输出**：SearXNG 默认只允许 `html/csv/rss`，`format=json` 的请求会被直接 **403** 拒绝。在实例的 `settings.yml`（Docker 部署常位于 `/etc/searxng/settings.yml`）确保：
>
> ```yaml
> server:
>   formats: [html, csv, json, rss]
> ```
>
> 改完重启 SearXNG 生效。

## 配置（cordis.patch.yml `config:`，均可在运行期热改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | （必填） | SearXNG 基地址（自动拼 `/search`），如 `https://searxng.example.com/search-api`。留空 = provider 不可用：未 pin 时被**静默跳过**（搜索静默走其他源，不报错），pin 了则报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
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

**前置条件**：已安装 DeepSeek Harness，且 `dsh` 命令可用（`dsh --version` 有输出）。若提示找不到命令：Windows 桌面版可先使用完整路径 `"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"`，或把该 `bin` 目录加入 PATH。不想用命令行也可以：DSH 设置 → 插件管理 → **添加插件**，粘贴 `https://github.com/luckyyzh/dsh-web-search-searxng`。

**第 1 步 · 安装插件**

```powershell
# 从 GitHub 安装到 desktop profile（当前可用）
dsh plugin --profile desktop add github:luckyyzh/dsh-web-search-searxng

# 或安装指定版本 / 发布到 npm 后按包名安装
dsh plugin --profile desktop add dsh-web-search-searxng@0.1.1
```

> `--profile` 为必填项（`desktop` / `web` / `headless`…），且必须紧跟在 `plugin` 之后、包名参数之前。命令等价于把参数转发给 pnpm，因此支持 npm 包名、`github:owner/repo`、git URL、本地绝对路径。多个 profile 想都启用就各装一次。

**第 2 步 · 配置实例地址**

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`（Windows 为 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`；`--profile` 换成对应名字），在**文件末尾**追加：

```yaml
- id: web-search-searxng
  name: dsh-web-search-searxng
  config:
    baseURL: https://searxng.example.com/search-api   # ← 改成你的 SearXNG 实例地址（必填，留空则插件不启用）
    tokenEnv: SEARXNG_TOKEN                           # 存放访问令牌的环境变量名
```

**第 3 步 · 配置访问令牌**（实例无需鉴权可跳过）

```powershell
# Windows（用户级，重新登录后对 GUI 启动的 DSH 生效；或直接注销重登）
[Environment]::SetEnvironmentVariable("SEARXNG_TOKEN", "你的令牌", "User")
```

```sh
# macOS / Linux：写入 shell 配置后从终端启动 dsh，或用 launchctl setenv SEARXNG_TOKEN 你的令牌
export SEARXNG_TOKEN="你的令牌"
```

**第 4 步 · 固定搜索源**（强烈建议；若 profile 里官方搜索源等其他源同时可用，跳过会报 `WEB_PROVIDER_AMBIGUOUS`）

继续在同一个 yml 末尾追加：

```yaml
- id: web
  config:
    searchProvider: searxng
```

**第 5 步 · 重启 DSH 并验证**

完全退出并重新打开 DSH（**只有新装插件**需要重启；`config:` 各项热更新，改完下一次搜索即生效），新建会话让助手执行一次 `web_search`。走通的特征：结果无 `utm_*` 等跟踪参数、中文查询以中文站为主、同域名结果不超过 2 条。

**常见报错**

| 报错 | 原因与处理 |
| --- | --- |
| `WEB_PROVIDER_CONFIGURED_MISSING` | 插件未安装成功：`dsh plugin --profile desktop why dsh-web-search-searxng` 检查；确认 patch 行 `name: dsh-web-search-searxng` 拼写 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | `baseURL` 未配置（默认空）或不合法。注意：`tokenEnv` 指向的环境变量**不存在并不会触发本错误**——可用性只取决于 `baseURL`，缺变量时照常发请求，实例要求鉴权才报 401 |
| `WEB_PROVIDER_AMBIGUOUS` | 未做第 4 步的 pin（同时有多个搜索源可用，必须显式指定一个） |
| 401 `rejected the access token` | 令牌错误/过期，与实例侧核对 |
| 403 `refused the request` | 最常见：实例未放行 `json` 格式（`settings.yml` 的 `server.formats` 加上后重启 SearXNG），其次才是令牌问题 |
| 无报错但结果明显不是本插件出的（URL 仍带 `utm_*`、同域名超过 2 条） | `baseURL` 留空导致插件被**静默跳过**（未 pin 时不报错，搜索走其他源）；或配置误写进了 `web-search-deepseek` 条目——两个条目字段同名，本插件的配置必须挂在 `- id: web-search-searxng` 下 |

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
