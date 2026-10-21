/**
 * chapter-fonts.mjs — 章的生僻字子集字体（GUJI-701 对读章起；GUJI-721 推到全部章、字源换成 Jigmo 2025.9.12）。
 *
 * 网站正文的基本区汉字由系统字体显示；扩 A、扩 B–J、兼容区和基本区末尾 U+9FA6–9FFF 要网络字体兜底。
 * 兜底是按码位切的静态分片（zi-fonts.css，每块 256 字，GUJI-721 第 2 步；之前是 jsDelivr 上的花园明朝分片），一章几个生僻字
 * 就要拉几块、上百 KB。所以打包时把一章用得到的字从 Jigmo 三档里裁出来合成一个 woff2（中位约 5KB），放在章文件旁边：
 * <章 file>.font.woff2；产物 index.json 的章条目记 `font_file`（文件名）与 `font_range`（子集里有字形的码位，unicode-range 语法）。
 * 一章生僻字超过 256 个（全站约百分之一的章）就按首次出现的先后切块：第 2 块起是 <章 file>.font-2.woff2…，
 * 记在 `font_parts: [{ file, range }]`，每块一条 @font-face，读到才下。
 * 阅读页服务端渲染时据此追加同字族（KygZi）的 @font-face（后定义的先查），这些字就不再去取分片；子集取不到时照旧回落分片。
 *
 * 收字：章正文（.txt）的全部字，对读章另加 char（原字）、norm（规范字）；再加全书目录（章名与各级标题），
 * 以及它们经网站繁→简入口（scripts/lib/to-simplified.mjs：异体归一＋opencc t2cn，与阅读器简体档同口径）转出来的字——
 * 网站默认简体，鉷→𫟹 这类转换结果本身就落在扩展区。正文按字逐个转、结果全站共用备忘（全站 11 亿字整段转太慢；
 * 词组级转换偶尔漏一两个字，漏了照旧回落分片），对读章的 char／norm 仍整段转（与 GUJI-701 同口径）。
 * 只收落在 FONT_RANGES 里的码位，Jigmo 里没有字形的由 chapter-fonts.py 再筛掉。
 *
 * 子集由 scripts/chapter-fonts.py（hb-subset＋fontTools）生成，要 python3（KYG_FONT_PYTHON，缺省 python3）+ uharfbuzz、fonttools、brotli
 * 与 Jigmo 三档 TTF 的目录（JIGMO_DIR）；KYG_FONT_CACHE 给了就跨次缓存（CI 用 actions/cache），KYG_FONT_CACHE_PRUNE=1 时删掉本次没用到的块。
 * KYG_CHAPTER_FONTS=required（CI 的三处打包都设，见 ops/setup-chapter-fonts.sh）：缺依赖直接失败——三处产物必须一致；缺省（本地）：缺依赖只警告、不生成。
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chapterTxtFile } from './text-layout.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FONT_SUFFIX = '.font.woff2';
/** 子集文件：第 1 块 001.font.woff2，第 2 块起 001.font-2.woff2 */
const FONT_FILE_RE = /\.font(?:-\d+)?\.woff2$/;
const SAFE_FILE = /^[\w.-]+$/;

/**
 * 要网络字体兜底的码位段（闭区间，升序）：扩 A、基本区末尾（Unicode 4.1 以后补的，老系统字体常常没有）、兼容区、
 * 扩 B–F／I 与兼容补充（第 2 平面）、扩 G／H／J（第 3 平面）。基本区 U+4E00–9FA5 交给系统字体，不进子集。
 */
export const FONT_RANGES = [
    [0x3400, 0x4dbf], [0x9fa6, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fa1f], [0x30000, 0x3347f],
];

export function inRanges(cp, ranges) {
    for (const [a, b] of ranges) {
        if (cp < a) return false;
        if (cp <= b) return true;
    }
    return false;
}

function readJsonOrNull(p) {
    try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function readTextOrEmpty(p) {
    try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

function collectStrings(v, out) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out);
}

/** 对读章页面上可能出现的原文：char 各格的字、norm 表里的规范字、全书目录的章名与标题 */
export function chapterSourceText({ char, norm, index }) {
    const parts = [];
    for (const pg of Array.isArray(char?.pages) ? char.pages : []) {
        for (const col of Array.isArray(pg?.columns) ? pg.columns : []) {
            for (const cell of Array.isArray(col?.cells) ? col.cells : []) if (typeof cell?.c === 'string') parts.push(cell.c);
        }
    }
    // norm 的形状随版本有变（items 列表／table 映射），只取字符串值：多收几个字无妨，少收就回落分片
    if (norm) collectStrings(norm.items ?? norm.table ?? norm, parts);
    for (const ch of Array.isArray(index?.chapters) ? index.chapters : []) {
        if (typeof ch?.title === 'string') parts.push(ch.title);
        for (const h of Array.isArray(ch?.headings) ? ch.headings : []) if (typeof h?.label === 'string') parts.push(h.label);
    }
    return parts.join('\n');
}

/**
 * 原文、再转简体的：合起来落在 ranges 里的码位，按首次出现的先后去重（原文的在前，转换才出现的跟在后面）。
 * 先后决定切块：一章超过 256 字时，前面的块管前面的页，读到后面才下后面的块。
 */
export function rareCodepoints(text, ranges, variants = [(s) => s]) {
    const seen = new Set();
    for (const f of variants) {
        for (const ch of f(text)) {
            const cp = ch.codePointAt(0);
            if (cp >= 0x3400 && inRanges(cp, ranges)) seen.add(cp);
        }
    }
    return [...seen];
}

/**
 * 逐字转换加备忘：variants 里每个转换都按「一字一行」整批转没见过的字，结果按字记下，下一章直接查。
 * 全站十几万章、去重后的字只有几万个，转换只做一遍（实测收字从 5.5 分钟降到几十秒）。
 * 一字一行转出来的仍是一字一行（to-simplified 保证字数不变），所以可以按行对回去。
 */
export function charVariantMemo(variants) {
    const memos = variants.map(() => new Map());
    return (chars) => {
        const out = [];
        variants.forEach((f, k) => {
            const memo = memos[k];
            const todo = chars.filter((c) => !memo.has(c));
            if (todo.length) {
                const conv = f(todo.join('\n')).split('\n');
                todo.forEach((c, i) => memo.set(c, conv.length === todo.length ? conv[i] : f(c)));
            }
            for (const c of chars) out.push(memo.get(c));
        });
        return out.join('');
    };
}

/** 条目输出目录下的文本版本目录（含 index.json 的直接子目录） */
function versionDirs(itemOutDir) {
    if (!existsSync(itemOutDir)) return []; // 整个条目 internal：copyItemDir 不建输出目录
    return readdirSync(itemOutDir)
        .map((n) => join(itemOutDir, n))
        .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'index.json')));
}

/**
 * 正文里「可能要字体」的字的正则：本身落在 ranges 里的，加上转简体后会落进 ranges 的基本区字（如 鉷→𫟹）。
 * 后一类先把基本区两万多字整批转一遍挑出来。正文只用这个正则扫一遍（原生、快），不必逐字建集合：全站 11 亿字，逐字建集合要两分多钟。
 */
export function rareCharRegex(ranges, convert) {
    const hex = (cp) => `\\u{${cp.toString(16)}}`;
    const cls = ranges.map(([a, b]) => `${hex(a)}-${hex(b)}`);
    const basic = [];
    for (let cp = 0x4e00; cp <= 0x9fff; cp++) basic.push(String.fromCodePoint(cp));
    const producers = basic.filter((c) => rareCodepoints(convert([c]), ranges).length > 0);
    return new RegExp(`[${cls.join('')}${producers.join('')}]`, 'gu');
}

/**
 * 收集一个条目里各章的任务：[{ dir, indexPath, file, out, cps }]。
 * 正文取产物里的 <file>.txt（copyItemDir 已把 .md 改名）；对读章另加 char／norm。目录（章名、标题）每章都收：阅读页侧栏常驻。
 */
export function collectFontJobs(itemOutDir, { ranges, variants, charVariants, bodyRe }) {
    const jobs = [];
    const convert = charVariants ?? charVariantMemo(variants);
    const re = bodyRe ?? rareCharRegex(ranges, convert);
    for (const dir of versionDirs(itemOutDir)) {
        const indexPath = join(dir, 'index.json');
        const index = readJsonOrNull(indexPath);
        if (!Array.isArray(index?.chapters)) continue;
        const toc = chapterSourceText({ index });
        const tocCps = rareCodepoints(toc, ranges, variants);
        for (const ch of index.chapters) {
            if (typeof ch?.file !== 'string' || !SAFE_FILE.test(ch.file)) continue;
            const body = readTextOrEmpty(join(dir, chapterTxtFile(ch.file)));
            const cps = rareCodepoints(convert([...new Set(body.match(re))]), ranges);
            if (typeof ch.char_file === 'string' && SAFE_FILE.test(ch.char_file)) {
                const char = readJsonOrNull(join(dir, ch.char_file));
                const norm = typeof ch.norm_file === 'string' && SAFE_FILE.test(ch.norm_file) ? readJsonOrNull(join(dir, ch.norm_file)) : null;
                if (char) cps.push(...rareCodepoints(chapterSourceText({ char, norm }), ranges, variants));
            }
            cps.push(...tocCps);
            jobs.push({ dir, indexPath, file: ch.file, out: join(dir, `${ch.file}${FONT_SUFFIX}`), cps: [...new Set(cps)] });
        }
    }
    return jobs;
}

/** 调 chapter-fonts.py 生成子集；返回与 jobs 对应的块列表 [{ file, range }]（空数组＝一个字形都没有，没写文件） */
export function runFontJobs(jobs, { jigmoDir, cacheDir, prune = false, python = 'python3' }) {
    const todo = jobs.filter((j) => j.cps.length > 0);
    if (todo.length === 0) return jobs.map(() => []);
    const r = spawnSync(python, [resolve(__dirname, '..', 'chapter-fonts.py')], {
        input: JSON.stringify({ jigmo: jigmoDir, ...(cacheDir ? { cache: cacheDir, prune } : {}), jobs: todo.map(({ out, cps }) => ({ out, cps })) }),
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`chapter-fonts.py 失败（${r.status}）：${(r.stderr || r.error?.message || '').slice(-2000)}`);
    if (r.stderr) process.stderr.write(r.stderr);
    const byOut = new Map(JSON.parse(r.stdout).map((x) => [x.out, x.parts]));
    return jobs.map((j) => byOut.get(j.out) ?? []);
}

/**
 * 把结果写回产物 index.json：第 1 块记 font_file／font_range，第 2 块起记 font_parts；没有子集就去掉这几个键。
 * 再删掉不再需要的旧子集文件。返回生成了子集的章数。
 */
export function applyFontResults(jobs, results) {
    const byIndex = new Map();
    jobs.forEach((j, i) => {
        if (!byIndex.has(j.indexPath)) byIndex.set(j.indexPath, { dir: j.dir, files: new Map() });
        byIndex.get(j.indexPath).files.set(j.file, results[i] ?? []);
    });
    let written = 0;
    for (const [indexPath, { dir, files }] of byIndex) {
        const raw = readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(raw);
        let changed = false;
        for (const ch of index.chapters) {
            if (!files.has(ch?.file)) continue;
            const [first, ...more] = files.get(ch.file);
            if (first) written++;
            const want = first ? { font_file: first.file, font_range: first.range, ...(more.length ? { font_parts: more } : {}) } : {};
            for (const k of ['font_file', 'font_range', 'font_parts']) {
                if (JSON.stringify(ch[k]) === JSON.stringify(want[k])) continue;
                changed = true;
                if (want[k] === undefined) delete ch[k];
                else ch[k] = want[k];
            }
        }
        // 没有改动就不动文件（不改源仓的排版字节）
        if (changed) writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
        const keep = new Set([...files.values()].flat().map((p) => p.file));
        for (const name of readdirSync(dir)) if (FONT_FILE_RE.test(name) && !keep.has(name)) unlinkSync(join(dir, name));
    }
    return written;
}

/**
 * 准备一次：载入转换器、检查依赖。
 * 依赖齐 → 返回 ctx；不齐 → KYG_CHAPTER_FONTS=required 时抛错，否则返回 { skip: '原因' }
 */
export async function chapterFontContext(env = process.env) {
    const required = env.KYG_CHAPTER_FONTS === 'required';
    const fail = (why) => {
        if (required) throw new Error(`章生僻字子集字体（GUJI-701／GUJI-721）：${why}`);
        return { skip: why };
    };
    if (env.KYG_CHAPTER_FONTS === 'off') return { skip: 'KYG_CHAPTER_FONTS=off' };
    const jigmoDir = env.JIGMO_DIR;
    if (!jigmoDir || !['Jigmo.ttf', 'Jigmo2.ttf', 'Jigmo3.ttf'].every((f) => existsSync(join(jigmoDir, f)))) {
        return fail('没设 JIGMO_DIR（Jigmo 2025.9.12 三档 TTF 的目录，见 ops/setup-chapter-fonts.sh）或目录里缺 Jigmo.ttf／Jigmo2.ttf／Jigmo3.ttf');
    }
    const python = env.KYG_FONT_PYTHON || 'python3';
    const probe = spawnSync(python, ['-c', 'import fontTools, brotli, uharfbuzz'], { encoding: 'utf-8' });
    if (probe.status !== 0) return fail(`${python} 缺 fonttools／brotli／uharfbuzz（pip install fonttools brotli uharfbuzz）`);
    // 简体档：与网站同一个繁→简入口（异体归一＋opencc t2cn，overview#448 S0），不自己 new Converter
    const { toSimplified } = await import('./to-simplified.mjs');
    const variants = [(s) => s, (s) => toSimplified(s)];
    const charVariants = charVariantMemo(variants); // 全站共用一份逐字备忘
    const bodyRe = rareCharRegex(FONT_RANGES, charVariants);
    // KYG_FONT_CACHE_PRUNE=1：本次没用到的缓存块删掉（只在打全站的 job 设，见 data.yml）
    return { ranges: FONT_RANGES, variants, charVariants, bodyRe, jigmoDir, cacheDir: env.KYG_FONT_CACHE || null, prune: env.KYG_FONT_CACHE_PRUNE === '1', python };
}

/** 一个条目：收集、生成、写回；返回生成了子集的章数 */
export function buildItemFonts(itemOutDir, ctx) {
    const jobs = collectFontJobs(itemOutDir, ctx);
    if (jobs.length === 0) return 0;
    return applyFontResults(jobs, runFontJobs(jobs, ctx));
}
