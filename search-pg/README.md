# search-pg：元数据搜索的 Postgres 后端（替换 Meilisearch）

上海搜索机自建 Postgres，`search-api`（Node，:7710）提供与 Meili `multi-search` 同形的接口，边缘函数 `edge-functions/api/search.js` 按开关选后端。
评估与方案：ai-team 仓 `team/网站/全文搜索/pg替换meili评估-20261119/README.md`；迁移计划（S1–S6）：Claude Doc「Postgres 迁移方案」。

## 目录
- `sql/schema.sql`：建 schema（psql 变量 `schema`，默认 `search_new`）、分区表 `search_doc`、`search_meta`
- `sql/indexes.sql`：GIN／btree 索引（灌完数据后再建）
- `sql/functions.sql`：`q2tsq`、`hit_json`、`search_one`（三段排序：书名 → 其他名称 → 简介；段内 title_chars↑ completeness↓；总数封顶 1000；热门词按书名字数桶取）
- `sql/roles.sql`：`search_ingest`／`search_ro`
- `api/`：`server.mjs`（POST `/multi-search`，Bearer；GET `/healthz`）、`lib/query.mjs`（请求校验、简介高亮片段）、`tests/`
- `ingest/`：`ingest-pg.mjs`（搜索机入库：同一套 render-docs／diff-docs 产物，全量＝建 search_new、灌、建索引、自检、整库换名；增量＝先删后 upsert、核对条数）、`pg-rows.mjs`（文档→行与词元）、`tests/make-fixture.mjs`（迷你产物，冒烟用）
- `deploy/`：`search-api.service`、`search-api.env.example`

## 上海机建库（Deploy）
```bash
createdb guji && psql -d guji -v ing_pw="'…'" -v ro_pw="'…'" -f sql/roles.sql
psql -d guji -v schema=search_new -f sql/schema.sql     # 灌数据（search-ingest，S3）后：
psql -d guji -v schema=search_new -f sql/indexes.sql && psql -d guji -v schema=search_new -f sql/functions.sql
# 整库换名：ALTER SCHEMA search RENAME TO search_old; ALTER SCHEMA search_new RENAME TO search; DROP SCHEMA search_old CASCADE;
cd api && npm ci --omit=dev && node --test tests/*.test.mjs
```
`functions.sql` 里的 `search_one` 设了 `plan_cache_mode = force_custom_plan`（泛型计划对热门词会选错）。

## 已知
- 单字热门词（如「書」）叠加 `sort=era/title` 约 0.7 秒（要对全部命中排序），在 2 秒超时内；常见组合（词＋筛选、无排序）p95 < 60ms。
- 简介高亮由 search-api 在 JS 里生成（80 字窗口，`\u0001…\u0002` 标记），与 Meili 的 crop 行为近似、不逐字相同。
- `juans` 索引不迁（前端无调用）。

## 开关（边缘函数）
COS `search/switch.json`：`{"backend":"meili|pg|shadow"}`，30 秒内生效；`SEARCH_BACKEND` 环境变量可强制覆盖。
`pg` 失败当场回落 Meili；`shadow` 返回 Meili 结果，5% 抽样后台打 PG，日志一行 JSON（top1／前 5 重合度／耗时）。

## 入库（search-ingest）
```bash
cd ingest && npm ci --omit=dev
PGHOST=… PGDATABASE=guji PGUSER=search_ingest PGPASSWORD=… node ingest-pg.mjs --docs <render-docs 输出>          # 全量
PGHOST=… PGDATABASE=guji PGUSER=search_ingest PGPASSWORD=… node ingest-pg.mjs --incremental <diff-docs 输出>    # 增量
```
产物与校验和 `indexer/ingest.mjs` 完全一样（搜索机现在拉的 search-xfer 包直接复用，state 单独记在 `/opt/search-pg/state.json`）。
目录库（A11 stable/latest）上线后，只要 render-docs 的数据源换成 `read_records(resolve stable)`，这一端不用改。
