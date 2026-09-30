# dsh-plugin-web-search 技术笔记

本仓库的 README 面向使用者；这里放契约、操作顺序、排障与内部结构。
搬运时只删去「当初怎么一步步做出来」的过程叙述，事实点（命令、路径、状态码、席位 id、限制、许可与出处）全部保留。

---

## 契约

### provider 身份：按「格式」兼容，而不是按「厂商」

本插件的 provider 身份是**它说哪种 wire 格式**，不是它叫什么名字——和 `llm-pi-ai` 里
`api: 'openai-completions'` + 用户自填 `baseURL` 完全同构。任何实现了该格式的服务都能接，
端点由你填。

卡片里的四个选项：

| 显示 | 含义 | 目标 URL 放在哪 |
|---|---|---|
| **兼容 SearxNG 格式** | `GET <端点>?q=…&format=json` | query string |
| **兼容 Jina 格式** | `GET <端点>/<目标URL>` | URL 路径 |
| **兼容 Firecrawl 格式** | `POST <端点>`，body `{"url":…,"formats":["markdown"]}` | JSON body |
| **内置 http（本机抓取）** | dsh 自带，无需端点 | — |

### 兼容 SearxNG 格式（搜索）

```bash
curl 'https://searx.example.org/search?q=deepseek&format=json'
```
```jsonc
// ← 200 application/json（format=json 必须在实例 settings.yml 的 search.formats 里启用）
{ "results": [ { "url": "…", "title": "…", "content": "…", "publishedDate": null } ] }
```
映射：`url`→url、`title`→title、`content`→snippet、`publishedDate`→publishedAt。缺字段的条目被跳过，
`truncated` 恒为 false（条数上界由接缝负责）。

### 兼容 Jina 格式（抓取）

```bash
curl -H 'Accept: application/json' -H 'Authorization: Bearer <key>' \
  'https://r.jina.ai/https://example.com/article'
```
```jsonc
// ← 200 application/json
{ "code": 200, "status": 20000,
  "data": { "title": "…", "url": "…", "content": "…", "publishedTime": "…" } }
```
不带 `Accept: application/json` 时返回 `text/plain`，正文原样采用（开头会带 `Title:` / `URL Source:` 抬头）。
**官方可自建**：`ghcr.io/jina-ai/reader:oss`（自带 headless Chrome / LibreOffice / CJK 字体，
暴露 8080 h2c 与 8081 HTTP/1.1）。

### 兼容 Firecrawl 格式（抓取）

```bash
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
  -H 'Authorization: Bearer <key>' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"],"onlyMainContent":true}'
```
```jsonc
// ← 200 application/json
{ "success": true,
  "data": { "markdown": "…", "metadata": { "title": "…", "sourceURL": "…", "statusCode": 200 } } }
```
`data.markdown` 缺失时回退 `data.html` / `data.rawHtml`（HTML 由工具层转 Markdown 并剔除
script/style/隐藏内容）；`success: false` 会作为失败回报。

> **宽容回退**：三个格式都额外识别 `content` / `text` / `markdown` / `body` / `data.*` 等同义字段，
> 因为"兼容"服务常是近似兼容。若一个 200 响应里**一个可识别字段都没有**，报错会**列出实际看到的键名**，
> 便于你适配自己的服务。

### 为什么要显式选择

同一能力注册了多个 provider 时，接缝**无法自动选中**（会报 `WEB_PROVIDER_AMBIGUOUS`）。
本插件注册了 1 个搜索 + 2 个抓取格式，而 dsh 自带 `http` 与 `deepseek-official` 也在注册表里，
所以 **`searchProvider` 与 `fetchProvider` 必须始终显式指定**——这正是接管写入的两行：

```yaml
# >>> dsh-plugin-web-search (managed block; do not edit) >>>
- id: web
  config:
    searchProvider: searxng
    fetchProvider: http
# <<< dsh-plugin-web-search <<<
```

### 席位与路由

- Host 半身 `lib/index.js` 的 inject 列表是 `web`、`settings`、`connection`、`webServer`；路由挂在组合的 `webServer` 上，前缀 `/web-search`。
- 可命中的端点只有 `state/read`、`config/save`、`takeover/restore`（其余 404）；请求体上限 64 KiB；`content-type` 必须是 `application/json`，否则 415。
- 每个请求先过接缝的信任栅栏 `connection.requestRejection(req)`；没有该接缝的组合回复 503。
- Browser 半身 `lib/client.js` 占据 `settings.section` 席位：id `web-search`、order `160`、locale namespace `web-search`；另在 `plugin-suite.panel` 聚合席位注册一份（该席位由 suite hub 声明，未安装时它不存在，自然不注册）。

### 已知限制

- 只实现上面三个格式；`providers` dict 与 `ADAPTERS` 表已留好扩展点
- 检索偏好（`language` / `categories` / `safesearch` / `time_range`）**不暴露**：
  接缝的 `WebSearchRequest` 只有 `query` 与 `maxResults`，这些只能是配置层常量
- `maxResults` 对三个格式都无处可传，由接缝在结果侧截断
- 请求超时固定 15 秒，不可配置
- patch 文件用**文本级**编辑（手术式替换 + 哨兵块），不做 YAML 往返 —— 为了保住用户手写的注释
- provider 注册表的枚举是**只读**的未文档化内部结构：读不到时优雅降级为空列表，
  外部 provider 仍可手填 id

---

## 操作与排障

### 接管与优先级

写入的是 **home patch 层** `$DSH_HOME/cordis.patch.yml`，官方语义即"机器级、覆盖所有 profile"，
所以它**压过** profile 自己的 `cordis.patch.yml`。patch 层序（低→高）：
bundle → profile → **home** → `--patch`。

patch 会**整体替换** `web` 行的 `config`，所以两个选择键都必须写全。

profile 是 `patchReload: live`，改完即热重载 `web` 行 —— **保存后无需重启，下一次调用生效**。

### 还原

卡片上的 **还原为默认** 删除管理块，把选择交还 profile patch 与 dsh 默认值。
也可手删 `$DSH_HOME/cordis.patch.yml` 里哨兵包裹的那段。

### 卸载顺序

**先还原、再卸载。** 否则残留的 `searchProvider: searxng` 会让搜索以
`WEB_PROVIDER_CONFIGURED_MISSING` 失败。

### `http` 还是远端抓取

| | 内置 `http` | 兼容 Jina / Firecrawl 格式 |
|---|---|---|
| 谁在抓 | **本机** dsh 进程 | 远端服务 |
| 本机 DNS | **强依赖**：必须能解析真实公网 IP | 完全不参与 |
| 部署 | 零 | 你要有一个（可用官方镜像自建） |
| 目标 URL 去向 | 本机直连 | 发给你配的服务 |

⚠️ **本机抓取会被 SSRF 防护拦下**：`dsh-web-fetch-http` 会解析目标域名并拒绝非公网 IP。
如果你的机器用了代理的 **fake-ip 模式**（域名解析到 `198.18.x.x`），所有抓取都会被判为
"non-public IP address" 而失败——此时把抓取交给远端格式（Jina / Firecrawl），或把相关域名加入
代理的 `fake-ip-filter`，或改用 `redir-host` 模式。

### 常见失败与含义

搜索/抓取失败时消息会指出**实际原因**，而不是笼统的 403：

| 现象 | 含义 |
|---|---|
| `HTTP 401/403` + 提示"反向代理拒绝" | 自定义 header 里的凭证不对 |
| `HTTP 403` + 提示 `search.formats` | SearxNG 未启用 json 输出 |
| `HTTP 404` | 端点写错。插件**不会**替你补路径 |
| `HTTP 429` | 实例限流 |
| `返回了重定向` | 该 URL 会 308，请直接填最终端点 |
| `响应里没有可识别的文本字段；实际看到：…` | 兼容服务的响应格式对不上，报错给出的键名可用于适配 |
| `registered but unavailable` | 选中的格式没填端点 —— 卡片里该格式会标"尚未填写端点" |

### link: 安装为什么要多跑一步

> 方式 B 的原因：Node 会 realpath 到真实路径再解析裸导入，`link:` 插件够不到
> `$DSH_HOME/profiles/node_modules`。`link-imports` 指向的是 dsh 自己创建的符号链接，
> **与 harness 加载的是同一份物理文件**，所以 `error instanceof HarnessError` 成立。
> **不要 `npm install` 那两个包** —— 副本会解析成功但破坏实例同一性，结构化错误码会静默消失。

### 实体安装（npm pack + tgz）与重启

README 只收录 GitHub 与本地目录两条路径。本包目前**未发布到 npm**，所以也不存在 `dsh plugin --profile web add dsh-plugin-web-search` 这条路线；原来的实体安装路线保留在这里：

```bash
# 方式 A（推荐，无需额外步骤）：实体安装，插件的裸导入由常规父级查找命中 dsh 安装闭包
npm pack && dsh plugin --profile web add ./dsh-plugin-web-search-0.2.0.tgz
```

加载插件需重启 dsh；重启会结束当前 agent 自己的进程，这一步交给用户。

---

## 内部结构

- **两半**：Host 半身 `lib/index.js` 向 `ctx.web` 注册 provider（`registerSearchProvider` / `registerFetchProvider`），注册用 `ctx.effect` + thunk，配置变化不重新注册（否则接缝的选择会闪烁）。Client 半身 `lib/client.js` 是 Settings 卡片，adapter 表与中英两个文案字典一一对应。
- **Config schema**：`provider`（搜索 adapter id，默认 `searxng`）、`fetchProvider`（默认内置 `http`）、`providers`（按 adapter id 的 dict，每项 `{ endpoint, headers }`）。三者全部 `.volatile()`，且 `providers` 作为 dict 节点本身 volatile —— 否则 `describe()` 会跳过该 entry，`update()` 报 `Plugin entry "web-search" has no volatile fields`。
- **保留头剔除**：`connection` / `content-length` / `content-type` / `host` / `transfer-encoding` / `accept-encoding` 不允许用户覆盖；`accept` / `authorization` / `user-agent` 故意不在名单里（部署需要自带）。
- **文本级 patch 编辑**：哨兵是 `# >>> dsh-plugin-web-search (managed block; do not edit) >>>` 与 `# <<< dsh-plugin-web-search <<<`；`applyTakeover` 写入，`releaseTakeover` 还原，不做 YAML 往返。
- **卡片行为**：折叠首屏无字段，展开后两个下拉；按格式分组显示端点与 header；切换格式重新装载配置；未配置格式显示告警；保存两端载荷、保存后收起；非法草稿本地拦截；外部 provider 不在此处配置；失败自动展开与重试。
- **注册与失败降级**：三个 adapter 各自 `ctx.effect` 注册，任一失败只 `console.error` 并让启动继续（抛错的 loader row 会带垮整棵插件树）。

### 扩展点：加一个格式

1. 在 `lib/index.js` 写一个 `create<Format>Provider(read)`（`available()` + `search()`/`fetch()`），
   用 `requestJson()` 统一超时/取消/重定向与 401/403/404/429 诊断
2. 在 `ADAPTERS` 加一条 `{ id, kind, labelKey, build }`
3. 在 `lib/client.js` 的两个文案字典加 `labelKey` 与该格式的端点提示键
4. 补 harness 断言

**schema 不需要改**（`providers` 是按 adapter id 的 dict），patch 与卡片也不需要改。

---

## 开发与验证

三套 harness 无外部依赖：

```bash
node --check lib/index.js && node --check lib/client.js
npm test                   # 三套无依赖 harness，212 条断言（131 + 42 + 39）
dsh --profile web --dump-config     # 应出现 - id: web-search 行
```

| Harness | 覆盖 |
|---|---|
| `test/host.test.mjs`（131） | 三个格式的请求构造与解码、宽容回退与键名诊断、header 解析与保留头剔除、patch 手术式编辑（`[]` 特例 / 注释保全 / 幂等）、两层探测、保存校验、配置合并、provider 注册表只读枚举、清单与 patch 契约、`apply` 不抛 |
| `test/client.test.mjs`（42） | bundle id == 包名、只 require `react`、`apply`/`inject` 导出、座位（slot name + cell key + locale）、双语文案键集一致、跨半身常量一致、每个 adapter 的标签键在两种语言里都存在 |
| `test/card.test.mjs`（39） | 折叠首屏无字段、展开后两个下拉、按格式分组的端点与 header、切换格式重新装载配置、未配置格式的告警、保存两端载荷、保存后收起、非法草稿本地拦截、外部 provider 不在此处配置、失败自动展开与重试 |

---

## 出处与许可

- 许可：**MIT**（`LICENSE`）。
- 三个格式来自各自服务方的 wire 协议（SearxNG / Jina Reader / Firecrawl）；本插件只实现客户端兼容层，不含它们的代码。
- Jina Reader 官方可自建：镜像 `ghcr.io/jina-ai/reader:oss`。
