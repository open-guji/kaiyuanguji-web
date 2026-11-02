# 后台「文本整理」栏目（已搬走）

2026-10-26 起这一栏只在项目组站 https://open-guji.com/admin/text （私密仓 open-guji-core/open-guji-site），本站不再有页面、接口和定时任务。

- 数据全部实时：新站的 Worker 打开页面时读 Neon 中心库 `progress` schema，并现算基础采集字段（册 yaml、待审单、book-text 版本），缓存约 5 分钟。
- 各领域怎么写数（`progress.put_volume`、`progress.put_metric`，软写口径）不变，完整文档和 schema、授权脚本在新仓的 `docs/text-progress.md`、`ops/text-progress/`。
