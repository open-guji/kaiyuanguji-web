# 字体可显示性基线测量脚本（GUJI-721，2026-10-20）

结论见 `docs/扩展区与未收字显示-基线测量.md`。这里的脚本只读 book-text、book-index、字体文件，不改任何数据。

## 准备

```bash
pip install fonttools brotli
# 候选字体：从 npm 拿（云会话里 GitHub Release、jsDelivr 被挡，npm 可达）
mkdir -p fonts && cd fonts
for p in hanamin fontpkg-jigmo @fontpkg/babel-stone-han @free-fonts/plangothic \
         @fontpkg/source-han-serif-sc @fontsource/noto-serif-sc @fontpkg/tw-sung @free-fonts/wenjin-mincho; do
  n=$(echo $p | tr '/@' '__'); mkdir -p $n; (cd $n && npm pack $p >/dev/null && tar xzf *.tgz)
done
cd ..
export FONTS_DIR=$PWD/fonts CV_FONTS=../open-guji-cv/fonts BOOK_TEXT=../book-text BOOK_INDEX=../book-index
```

## 顺序

| 脚本 | 做什么 | 产出 |
|---|---|---|
| `blocks.py` | 各区码位范围、网站现行判据（照抄 `nextjs/src/lib/zi-display.ts`） | 被别的脚本引用 |
| `cover.py` | 各字体 cmap 按区计数 | `cmaps.pkl` |
| `scan.py` | book-text 全部 `.md`：非基本区汉字、PUA、IDC 逐码位计数，按条目×版本 | `scan.pkl`（4 核约 45 秒） |
| `scan2.py` | 组字式互斥分类：`:zi[…]` → CBETA `[…]` → `{…}` → `[A1B2]` → `&KR…;` → 裸 IDS（按 IDS 语法解析） | `pats.pkl` |
| `agg.py` | 汇总：分区、现判据显示不出、各字体缺字、按来源 | 打印 |
| `scanidx.py` | book-index 元数据条目（整份 JSON＋题名） | `idx.pkl` |
| `chap.py` | default 版本每章的非基本区码位集合 | `chap.pkl` |
| `jigmo_chunks.py` | Jigmo 2025 按 256 码位切 woff2，量每块大小 | `jigmo_chunks.json`（4 核约 5 分钟） |
| `dl.py` | 每章阅读页按 unicode-range 要拉几块、多少 KB：花园明朝现状／文津宋体 npm 分块／Jigmo 自切分块 | `dl.json` |
| `vol04.py` | vol04 待审单相似字：照 `proofing.ts` 取 `alt`、照 `zi-display.ts` 判显示不出（参数：`004.pending.json` 路径） | `vol04_zi.json` |
| `vol04_font.py` | 上面那些字：Jigmo 2025／文津宋体缺字、整单与逐卡子集大小、Jigmo 256／128 码位块与文津 npm 块要拉多少 | `vol04_font.json`（4 核约 3 分钟） |
