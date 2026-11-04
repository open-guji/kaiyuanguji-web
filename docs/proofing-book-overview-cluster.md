# 全书校对总览与跨册成批校对

- `/proofing/<book>`：这本书共有多少待选格、各大类／各原因占多少、每册还剩多少。最上面是「成批校对」：只看图就能定的原因（`BATCH_REASONS`：lib_missing、lib_sparse_agree、lib_unrecognized、occluded_with_ref）每个字一行，直接摆出各格小图，缺省全选，点一格挑出，单行确认或整页一起确认；挑出的格留在单子上。
- `/proofing/<book>/c/<聚类键>`：同一原因、同一个整理本字的待选格跨册排在一起，图上都是这个字就一次确认；
  挑出来的单格直接用逐册校对页的单格卡片（`CellRow`，候选、相似字、字框切分错误等单选项、备注都在里面），提交方式同逐册页，一格一票；
- 数据：`proof/<book>/summary.json`，由 proofing-sync 每日生成（`scripts/lib/proofing-summary.mjs`）：
  `{v:1, book, chaps:{章:{rev,n,reasons,voted?}}, clusters:[{k,r,c,n,chaps}]}`，聚类最多 800 个。
- 聚类键 `<pending_reason>~<整理本字，缺省机器字>`，由待审单已有字段推出，cv 不需要改动。
- 成批提交：`POST /api/cellreview-batch {aid, items[1..50]}`，每项与单格 `/api/cellreview` 一致，
  成批确认的票 `pick_src: 'cluster'`；每格仍是一条独立的票，后面 `guji cellvotes` 照旧转成人裁（带 `payload.pending_reason`）。
