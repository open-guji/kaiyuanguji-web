# IIIF canvas 编号统一方案（书影页序 ＝ 对读数据页序）

状态：**方案，待 Sheldon 点头后再动手**；本文不改任何线上 manifest。
起因：史记（988g3f0wsu）校对页整页书影「加载中」。PR #835 在前端加了「编号对不上就按顺序对位」的兜底，只是过渡。

## 1. 现状盘点（2026-11-20，线上 data.openguji.com 实测）

| 书 | manifest canvas 编号 | cord.json 的 canvas.seq | 是否一致 |
|---|---|---|---|
| 北行日錄 988g7gsqhd | 0001…（页序） | 0003…（cord page＝3 起，seq 同页序） | 一致 |
| 欽定全唐文 995ejelvk0（29 册） | 0001…（页序，`pages_iiif.py::seq_by_page` 按 cord page 编） | 0001… | 一致 |
| 蘇溪漁隱讀書譜 993z4jltz4（3 册） | 0001… | （未上线对读） | manifest 为页序 |
| 四庫總目 96mid1ogzk | 0001…（leaf 号；合扫叶才带 a–d） | 0001… | 一致（该书拆页册未逐册核） |
| **史記 988g3f0wsu（42 册）** | **0006a、0006c、0006d、0007a…（IA/Commons 叶号＋半叶后缀，每页都带）** | **0001、0002…（页序，连续）** | **42 册 0 个对得上**（页数逐册相同，宽高逐页一致） |
| **脈經 99k3i35yww（6 册）** | **0001b、0002a、0002b…（半叶后缀）** | 未上线对读 | 同类风险，对读上线前必撞 |

要点：
- 网站的既有约定（`pages_iiif.py::seq_by_page` 文档）是「cord page ＝ canvas seq，从 1 起、四位补零」，阅读页、精校页都按它对位。史记、脈經走的是旧路径，该函数遇到带后缀的页表**主动不改**，于是 manifest 留着半叶号，cord 侧却是页序。
- 前端 `canvasesToImages` 的 `seq` 取自 **图片 URL**（`/(\d{4})([a-z]?)/full/`），不是 canvas id，所以光改 canvas id 不够。
- 待审单的格键是 `页:列:格`，页是 cord page，**不含 seq**；页→书影的对位走 cord 的 canvas.seq。因此改编号**不改格键、不动人裁记录**。

## 2. 统一规范（建议）

1. **canvas seq ＝ cord page 四位补零**（`0001`…），全站所有书、所有册同一规则。manifest canvas id 尾段、图片 URL 的页序段、cord canvas.seq、待审单页序四处相同。
2. 半叶／叶号信息不再进编号：放 canvas `label`（如「第 6 葉 a」）和新增元数据 `bim:leaf: {leaf: 6, part: "a"}`，供阅读器显示和拆页判断。
3. 契约检查进 CI：对每本已上线书，cord 的 canvas.seq 集合必须等于 manifest 的 canvas seq 集合（`ops/iiif/check_cord_vs_splits.py` 已有同类脚本，扩成逐册契约测试；新书首发清单加一条）。
4. 前端兜底（#835）保留一版，契约上线且全书迁完后可删。

## 3. 迁移方案

改动面只在**生成端和已有的史记／脈經 manifest**，数据侧（cord、待审单、人裁）不动：

- `ops/iiif/pages_iiif.py::seq_by_page`：不再因后缀跳过，带后缀的页表同样按 cord page 重编；叶号、半叶后缀进 `leaf`／`part` 字段传到 label 与 `bim:leaf`。（`siku_zongmu_iiif.py` 路径的四庫總目拆页册同理，先核再改。）
- `build_canvas`：label 改为「第 N 葉 a」；新增 `bim:leaf`。
- `attach_pagemeta(by_seq=…)`：沿用现有「canvas seq → 页表原 seq」对照，旁车文件（bim:page／bim:cos）不用重做。
- 前端 `canvasesToImages`：seq 优先取 canvas id 尾段，取不到再退回图片 URL（兼容尚未迁移的旧 manifest）。

迁移已有书时，图片对象怎么放有两条路，**需要你选**：

| | A. 只重发 manifest（推荐） | B. 同时按新编号重命名图片对象 |
|---|---|---|
| 做法 | canvas id、label 换成页序；图片/服务 URL 仍指向旧对象（`…/0006a/full/…`），不动 COS 图片 | 把 COS 里 `<册>/0006a/…` 拷成 `<册>/0001/…`（服务端拷贝，不用重切重传），manifest 全指新路径 |
| 工作量 | 史记 42 册＋脈經 6 册 manifest，几分钟 | 约 6k 页 × 3 档对象拷贝，慢，占存储（旧对象可延后删） |
| 风险 | 图片路径里还留半叶号（只是不透明的存储键，不影响对位） | 路径与编号彻底统一；拷贝期间要保证旧路径不先删 |
| 回滚 | 重发旧 manifest（发之前先备份 `manifest.json`） | 同左，旧对象保留到验完 |

## 4. 对线上与人审的影响

- 史记待审单、人裁记录、字形库：**无影响**（键里没有 seq）。
- 史记阅读页：若阅读页用同一套对位，现在大概率也有同样缺图，迁完一并好；迁之前先在测试站点一页确认。
- 发布顺序：生成端 PR → 测试站（iiif 工作流只重发这两本的 manifest）→ 契约检查全绿 → Sheldon 点头 → 正式站。重发 manifest 会让 CDN 缓存刷新，期间书影可能短时 404，选深夜单册先试。
- 全唐文、北行日錄、蘇溪漁隱：编号本已统一，**不重发**。

## 5. 需要 Sheldon 定的

1. 图片对象走 A（只重发 manifest）还是 B（连路径一起统一）。
2. 是否同意在测试站先重发史记第 1 册作演练，再批量。
3. 脈經现在还没上线对读，是否同批迁（建议同批，趁没人看）。
