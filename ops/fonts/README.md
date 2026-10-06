# 花园明朝扩展区字兜底（overview#421）

宋体系统字体不带扩展 A–F 的生僻字（𠮓、𫎇、㫖 等），读者机器上没有字体时显示成空白，还会带坏同一段里后面的字。
全站字体栈末尾加了 `"HanaMinA", "HanaMinB"`（花园明朝），按 `unicode-range` 只在遇到系统字体没有的扩展区字时才下载。

## 两层
- **全量分片**：HanaMinA（扩展 A、兼容表意文字）与 HanaMinB（扩展 B–G、兼容补充），每 1024 个字一片，分片不跨区段，约 59＋10 片、共约 16 MB，各 200 KB 上下。
  只有出现了前面所有字体都没有的、落在这一片里的字，浏览器才下这一片。
- **实际用到的字**（`hanamin-used-chars.txt`）：book-text 里读者真会看到的扩展区字（含繁→简、异体字归一转出来的），每个字体一个几 KB 的小子集，
  CSS 里后声明、优先级高。我们自己的书只会下这两个小文件（合计约 17 KB）；普通页面一个字节也不下。

## 流程
```bash
# 1. 重扫用到的字（新书进 book-text 之后）。目录可以传多个；只读
cd nextjs && node scripts/collect-hanamin-chars.mjs <book-text 目录>...

# 2. 生成 woff2＋CSS，并把 @font-face 写进 globals.css 的 HANAMIN-BEGIN／END 之间
pip install fonttools brotli
python3 ops/fonts/build-hanamin.py --write-globals        # 产出在 ops/fonts/dist/hanamin（不进 git）

# 3. 先传 COS、后部署（文件没传上去就上线，扩展区字照旧显示空白）
DRY_RUN=1 node nextjs/scripts/sync-fonts-to-cos.mjs       # 先看会传什么
COS_SECRET_ID=… COS_SECRET_KEY=… COS_BUCKET=… node nextjs/scripts/sync-fonts-to-cos.mjs
```
- `build-hanamin.py` 的下载、解压、写文件都是先落临时路径再换名，`manifest.json` 最后写；`sync-fonts-to-cos.mjs` 只信它：没有 manifest 拒绝，每个 woff2 按里面的字节数与 sha256 核对，
  对不上就整个中止、什么都不传；COS 上已有的同名对象比字节数，不一致重传；上传顺序是授权文件 → woff2 → manifest，没有授权文件就不会有公开的字体。
- 字体文件名由规则与输入决定（分片＝区段序号＋修订号 `REV`，用到的字＝字表哈希），COS 上 `immutable` 长缓存，永不覆盖；
  改了分片规则就把 `build-hanamin.py` 里的 `REV` 加一。
- 上游压缩包 `hanazono-20170904.zip` 的 sha256 锁在脚本里，下载后校验；授权全文见 `HanaMin-LICENSE.txt`，根目录 `NOTICE` 有声明。
- 站点政策是「只用系统字体、不下载网络字体」（overview#240）；这是用户 10-06 定的唯一例外。
