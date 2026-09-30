# dsh-plugin-web-search

[English](README.md) | 中文

在 **设置 → 配置 → 插件配置** 里选择 DSH 的 **搜索 provider** 与 **抓取 provider**，并接管 `web` 行。

## 功能

- 在 **设置 → 配置 → 插件配置** 里的 Web Search 卡片上用下拉选择 DSH 的**搜索 provider** 与**抓取 provider**，不用手写 patch。
- 提供三种 wire 格式：**兼容 SearxNG 格式**（搜索）、**兼容 Jina 格式**（抓取）、**兼容 Firecrawl 格式**（抓取）；任何实现该格式的服务都能接，端点由你填。
- 保留 dsh 自带的**内置 http（本机抓取）**作为一个免端点选项。
- 保存即接管 `web` 行（写入 home patch 层），**无需重启，下一次调用生效**。
- 卡片上的**还原为默认**一键删除管理块，把选择交还 profile patch 与 dsh 默认值。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:CJ-SH/dsh-plugin-web-search
```

### 从本地目录安装

```bash
dsh plugin --profile web add ./dsh-plugin-web-search
```

link: 开发安装需多跑一步，把 peer 链到 dsh 共享闭包：

```bash
(cd ./dsh-plugin-web-search && npm run link-imports)
```

加载插件需重启 dsh；重启会结束当前 agent 自己的进程，这一步交给用户。

## 使用

- 入口：**设置 → 配置 → 插件配置 → Web Search**。
- 卡片默认折叠，只显示标题；展开后是两个下拉：**搜索 provider** 与**抓取 provider**。
- 选中本插件的格式后，下方出现该格式的**端点**与**自定义 header** 输入；未填端点的格式会标「该格式尚未填写端点，保存后仍不可用。」
- 保存后卡片收起，选择写进插件配置并接管 `web` 行；失败时卡片自动展开并显示原因。
- 配置文件是 `$DSH_HOME/cordis.patch.yml` 里哨兵包裹的那段。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-web-search
```

## 技术说明

- 同一能力注册了多个 provider 时接缝**无法自动选中**（报 `WEB_PROVIDER_AMBIGUOUS`），所以 `searchProvider` 与 `fetchProvider` **必须始终显式指定**。
- 抓取选**内置 http** 时由本机 dsh 进程直连，**强依赖本机 DNS 能解析真实公网 IP**；代理的 **fake-ip 模式**会让所有抓取被判为 "non-public IP address" 而失败。
- 只实现上面三种格式；检索偏好（`language` / `categories` / `safesearch` / `time_range`）不暴露，`maxResults` 对三个格式都无处可传。
- 请求超时固定 15 秒，不可配置。

## 深入阅读

契约、排障与内部结构见 [docs/design-notes.md](docs/design-notes.md)。

## License

MIT © 2026 HenTaiCJN
