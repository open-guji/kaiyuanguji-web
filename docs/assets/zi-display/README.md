# 扩展区与未收字显示：实测脚本与结果（2026-10-20，GUJI-721）

设计文档见 `docs/扩展区与未收字显示-设计.md`。这里是它引用的数和量法，一次性调研脚本，不进构建。

| 文件 | 做什么 |
|---|---|
| `scan.py` | 扫 book-text 全仓 `Work/`、`Book/` 下的章文件（`NNN.md`），逐章记非基本区汉字、PUA、IDS 符号的字次，以及组字式（CBETA `[口*恒]`、十六进制 `[B18D]`、维基 `{宀兒}`、IDS 串）。`python3 -I scan.py <book-text> scan.jsonl`，4 核约 3 分钟 |
| `blocks.py` | 各区段的码位范围（Unicode 17） |
| `cover.py` | 读各候选字体的 cmap，按区段数覆盖 → `font-coverage.json`。字体路径写死在脚本头，重跑时改 |
| `agg.py` | 汇总 `scan.jsonl` → `book-text-stats.json`（各区字种字次、超出花园明朝／Jigmo 的字、每章生僻字数分布、组字式与 PUA） |

候选字体取自 npm（云会话里 jsDelivr、GitHub Release、GlyphWiki 都连不上，npm 能连）：
`hanamin@0.0.5`、`fontpkg-jigmo@2025.9.12`（三个 TTF 与官方压缩包逐字节相同，见包内 `SOURCE.md`）、
`@fontpkg/babel-stone-han@15.0.4`、`@free-fonts/plangothic@1.0.0`、`@fontpkg/source-han-serif-sc@2.3.3`、
`@fontpkg/tw-sung@1.0.0`、`@fontpkg/unifont@15.0.1`；I.Ming、Jigmo 20230816 用 cv 仓 `fonts/`。
**上线时字体从上游官方发布取**，npm 包只用来量。
