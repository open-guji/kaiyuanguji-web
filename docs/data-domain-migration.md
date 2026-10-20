# 数据域名迁移：data.kaiyuanguji.com → data.openguji.com

2026-10-20 起草。目标：网站、脚本、CI 读数据改走 `data.openguji.com`；旧域名 `data.kaiyuanguji.com` 继续可用（不下线）。
同时把所有域名、子域名、API 地址收进一个配置文件，以后再迁只改一处。

## 进度

- 2026-10-20 PR①（#550）：域名集中到 `config/hosts.json`，值不变，已上线。
- 2026-10-20 Sheldon 在 EdgeOne 新建 openguji.com 站点（CNAME 接入，DNS 不搬），加 data 加速域名，回源同一个 COS 桶；证书、版本指针缓存规则、跨域响应头均照旧域名配好，实测与旧域名一致。
- 2026-10-20 PR②：`config/hosts.json` 的 data 改为 `https://data.openguji.com`，新增 `legacyData`（旧域名）。清缓存同时清新旧两个域名（新域名用密钥 `EDGEONE_DATA_ZONE_ID`，没配就跳过并警告）；证书巡检自动带上两个域名；IIIF 生成脚本的 id 仍用旧数据域名。

## 切换前的现状（2026-10-20 实测）

- `data.kaiyuanguji.com`：EdgeOne 加速（kaiyuanguji.com 站点）→ 新加坡 COS 桶。COS 回 `Access-Control-Allow-Origin: *`；`latest.json` 回 `max-age=30`。
- `data.openguji.com`：**尚未解析**。
- 写死旧数据域名的地方：本仓库约 60 个文件（网站代码、边缘函数、`ops/` 脚本、9 个工作流、清缓存、证书监控、测试）；
  另有 `open-guji-monitor`（`monitor/config.mjs`、`e2e/fixtures/anchors.ts`）、`book-index-manager`（只有注释）。
- 数据本身：IIIF manifest 里的图片地址和 canvas id、`book-text` 里 cord 的 1817 处 canvas id 用的是绝对地址 `https://data.kaiyuanguji.com/iiif/...`。
  网站与 book-index-ui 只按路径取页序和册号（`/iiif/<书>/canvas/<册>/<页序>`），**与主机名无关**，所以这些不改也不影响阅读页。

## 第 0 步：地址集中成常量（代码 PR①，不改任何线上行为）

- 唯一来源：仓库根 `config/hosts.json`（数据、API、正式站、测试站、ssr-test、旧域名、OAuth issuer）。
- 各处只引用它：

  | 用在哪 | 怎么取 |
  |---|---|
  | 网站代码（`nextjs/src`） | `import { DATA_ORIGIN } from '@/lib/hosts'`（`nextjs/src/lib/hosts.ts`，生成） |
  | 边缘函数 | `import { DATA_ORIGIN } from './hosts.js'`（`edge-functions/api/hosts.js`，生成；部署时只拷 `edge-functions/`） |
  | Node 脚本（`ops/`、`nextjs/scripts/`、`e2e/`、`perf/`） | `config/hosts.mjs`；CommonJS 直接 `require('config/hosts.json')` |
  | Python（`ops/`） | `ops/hosts.py`（`import hosts`） |
  | Shell | `node -p "require(<路径>/config/hosts.json).data"` |
  | 工作流 | 顶部 `env:` 里生成的 `HOST_DATA`、`HOST_SITE` 等；`run:` 里 `$HOST_DATA`，步骤 `env:` 里 `${{ env.HOST_DATA }}`。任务级、顶层 `env:` 里 GitHub 不许引用 `env`，改在任务第一步写 `GITHUB_ENV` |

- 改域名的流程：改 `config/hosts.json` → `node ops/sync-hosts.mjs` → 提交。`ops/tests/hosts.test.mjs`（`test.yml` 每个 PR 跑）会拦住
  ① 生成物没同步 ② 代码、脚本、工作流里又写死了本站域名。
- 例外（测试不查）：注释、文档、测试与夹具、`nextjs/public/` 静态页、`indexer/`（单独 tar 到机器上跑，靠 `/opt/indexer/.env` 的 `PURGE_HOST` 配）、
  工作流手动输入的 `default`／`options`（GitHub 不许在这里用变量；只放站点主机，数据与接口域名不许出现）。
- 这一步合并后线上一切照旧（值还是 data.kaiyuanguji.com）。

## 第 1 步：控制台操作（需要 Sheldon 做）

1. **EdgeOne 站点**：确认 `openguji.com` 是否已作为「站点」接入 EdgeOne（www.openguji.com 是 Pages 自定义域名，不一定代表站点已接入）。
   没有的话：EdgeOne 控制台 → 站点列表 → 添加站点 `openguji.com`，接入方式选 CNAME 接入即可（不必改 NS）。
   **请和 kaiyuanguji.com 在同一个账号、同一个版本（中国站／国际版）下**：CI 清缓存用的是同一组 `TENCENT_SECRET_ID` 和接口地址，
   版本不同就要另配密钥与端点。加速区域要含中国大陆的话，openguji.com 已备案，可以直接选。
2. **加速域名**：在 `openguji.com` 站点 → 域名服务 → 添加域名 `data`：
   - 源站类型选「COS 源」，选和 `data.kaiyuanguji.com` **同一个桶**；回源 HOST、私有桶回源鉴权等照抄旧域名的设置。
   - 加速区域与旧域名一致。
3. **证书**：该加速域名 → HTTPS 配置 → 申请免费证书（或上传）；打开「强制 HTTPS」、HTTP/2。
4. **DNS**：在 openguji.com 的 DNS 服务商加 `data` 的 CNAME，指向 EdgeOne 给出的 CNAME（若要求验证归属，按提示加 TXT）。
5. **规则引擎／缓存**：把 `data.kaiyuanguji.com` 上的规则照抄到新域名，至少包括：
   - `latest.json`、`web.json`、`h1/manifest-root.json`、`h1/text-manifest-root.json`（含 `staging/` 下的）节点不缓存或极短缓存；
   - 书影图片（`/iiif/`、`/asset/`）长缓存；智能压缩（br／gzip）；
   - 旧域名上若有加响应头（跨域等）的规则，也照抄。
6. **清缓存密钥**：如果 openguji.com 是新建的站点，它的站点 ID 和 kaiyuanguji.com 不同。请把它加成 GitHub 仓库密钥
   `EDGEONE_DATA_ZONE_ID`（kaiyuanguji-web → Settings → Secrets → Actions），并确认现有 `TENCENT_SECRET_ID` 对应的子账号对新站点有清缓存权限。
7. 做完告诉我，我来验证。

## 第 2 步：验证新域名（我做）

`latest.json`、某个 `v/<commit>/` 分片、`iiif/.../manifest.json`、一张书影图都 200 且与旧域名字节一致；
证书有效；跨域头、`cache-control`、压缩与旧域名一致；国内／海外各测一次。

## 第 3 步：切换（代码 PR②，我做，可随时回退）

- `config/hosts.json` 把 `data` 改成 `https://data.openguji.com`，同步生成物。
- 清缓存：发布时**新旧两个域名**的数据指针都清（旧域名还会有人读）。
- 证书监控：新旧两个域名都查。
- `/api/version` 和构建信息的数据根白名单接受新旧两种。
- 合并后约 15 分钟上线；跑一遍 verify／e2e，看阅读页、书影、搜索、条目页。
- 回退：把 `config/hosts.json` 改回去即可。
- 同时改 `open-guji-monitor` 的默认数据根，并把 `data.openguji.com` 加进它的证书巡检。

## 第 4 步：数据里的绝对地址（待 Sheldon 定）

- 书影 manifest 里的**图片地址**：不重新生成的话，书影图继续走旧域名（能用，但流量和缓存分在两个域名上）。
  重新生成（`iiif-siku-zongmu.yml`，`PUBLIC_BASE` 已改为读配置）后图片走新域名。
- **canvas id**（manifest 与 cord 里）：IIIF 里它是标识符，不是下载地址；网站只按路径取页序。建议**保持不变**，免得改 book-text 的 1817 处数据。
- 建议：切换稳定后重新生成 manifest 的图片地址，canvas id 不动。

## 不在本次范围

- `api.kaiyuanguji.com`（搜索）、`staging.kaiyuanguji.com`、`ssr-test.kaiyuanguji.com` 本次不迁，只是收进同一个配置，以后要迁也只改一处。
- OAuth 的 `iss`（`https://www.kaiyuanguji.com`）不能随便改，已登录的令牌会失效；同样只收进配置。
