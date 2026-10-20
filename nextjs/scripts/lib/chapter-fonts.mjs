/**
 * chapter-fonts.mjs — 对读章的生僻字子集字体（GUJI-701）。
 *
 * 网站的扩展区汉字兜底是花园明朝（src/app/globals.css 的 HANAMIN 段：按 unicode-range 分片，每片约 200KB）。
 * 一章几十个生僻字散在十几片里，读者要下 3～4MB（对读章 96mid1ogzk/002：31 字、19 片、3.6MB）。
 * 打包时把一章用得到的字抽出来合成一个 woff2（约 10KB），放在章文件旁边：<章 file>.font.woff2，
 * 并在产物 index.json 的章条目里记 `font_file`（文件名）与 `font_range`（子集里有字形的码位，unicode-range 语法）。
 * 阅读页服务端渲染时据此追加同字族的 @font-face（后定义的先查），这些字就不再去取大分片；子集取不到时照旧回落分片。
 *
 * 范围：只做对读章（章条目声明了 char_file）。字取自 char（原字）、norm（规范字）、全书目录（章名与各级标题），
 * 再加上它们经网站繁→简入口（scripts/lib/to-simplified.mjs：异体归一＋opencc t2cn，与阅读器简体档同口径）转出来的字——
 * 网站默认简体，鉷→𫟹 这类转换结果本身就落在扩展区。只收落在 HANAMIN 段 unicode-range 里的码位。
 *
 * 子集由 scripts/chapter-fonts.py（fontTools）生成，要 python3（KYG_FONT_PYTHON，缺省 python3）+ fonttools + brotli 与 hanamin@0.0.5 包目录（HANAMIN_DIR）。
 * KYG_CHAPTER_FONTS=required（CI 的三处打包都设，见 ops/setup-chapter-fonts.sh）：缺依赖直接失败——三处产物必须一致；缺省（本地）：缺依赖只警告、不生成。
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FONT_SUFFIX = '.font.woff2';
const SAFE_FILE = /^[\w.-]+$/;

/** globals.css 里 HANAMIN-BEGIN…HANAMIN-END 段的 unicode-range，合并成 [起, 止] 列表 */
export function hanaminRanges(css) {
    const begin = css.indexOf('HANAMIN-BEGIN');
    const end = css.indexOf('HANAMIN-END');
    if (begin < 0 || end < begin) throw new Error('globals.css 里找不到 HANAMIN-BEGIN／HANAMIN-END 段');
    const ranges = [];
    for (const m of css.slice(begin, end).matchAll(/unicode-range:\s*([^;}]+)/g)) {
        for (const part of m[1].split(',')) {
            const p = part.trim().toUpperCase().replace(/^U\+/, '');
            if (!p) continue;
            const [a, b = a] = p.split('-');
            ranges.push([parseInt(a, 16), parseInt(b, 16)]);
        }
    }
    return ranges.sort((x, y) => x[0] - y[0]);
}

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

function collectStrings(v, out) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out);
}

/** 一章页面上可能出现的原文：char 各格的字、norm 表里的规范字、全书目录的章名与标题 */
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

/** 原文、异体归一后的、再转简体的：三者合起来落在 ranges 里的码位（升序去重） */
export function rareCodepoints(text, ranges, variants = [(s) => s]) {
    const seen = new Set();
    for (const f of variants) {
        for (const ch of f(text)) {
            const cp = ch.codePointAt(0);
            if (cp >= 0x3400 && inRanges(cp, ranges)) seen.add(cp);
        }
    }
    return [...seen].sort((a, b) => a - b);
}

/** 条目输出目录下的文本版本目录（含 index.json 的直接子目录） */
function versionDirs(itemOutDir) {
    return readdirSync(itemOutDir)
        .map((n) => join(itemOutDir, n))
        .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'index.json')));
}

/** 收集一个条目里各对读章的任务：[{ dir, indexPath, file, out, cps }] */
export function collectFontJobs(itemOutDir, { ranges, variants }) {
    const jobs = [];
    for (const dir of versionDirs(itemOutDir)) {
        const indexPath = join(dir, 'index.json');
        const index = readJsonOrNull(indexPath);
        if (!Array.isArray(index?.chapters)) continue;
        for (const ch of index.chapters) {
            if (typeof ch?.file !== 'string' || !SAFE_FILE.test(ch.file)) continue;
            if (typeof ch.char_file !== 'string' || !SAFE_FILE.test(ch.char_file)) continue;
            const char = readJsonOrNull(join(dir, ch.char_file));
            if (!char) continue;
            const norm = typeof ch.norm_file === 'string' && SAFE_FILE.test(ch.norm_file) ? readJsonOrNull(join(dir, ch.norm_file)) : null;
            const cps = rareCodepoints(chapterSourceText({ char, norm, index }), ranges, variants);
            jobs.push({ dir, indexPath, file: ch.file, out: join(dir, `${ch.file}${FONT_SUFFIX}`), cps });
        }
    }
    return jobs;
}

/** 调 chapter-fonts.py 生成子集；返回与 jobs 对应的 range（null＝一个字形都没有，没写文件） */
export function runFontJobs(jobs, { hanaminDir, python = 'python3' }) {
    const todo = jobs.filter((j) => j.cps.length > 0);
    if (todo.length === 0) return jobs.map(() => null);
    const r = spawnSync(python, [resolve(__dirname, '..', 'chapter-fonts.py')], {
        input: JSON.stringify({ hanamin: hanaminDir, jobs: todo.map(({ out, cps }) => ({ out, cps })) }),
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`chapter-fonts.py 失败（${r.status}）：${(r.stderr || r.error?.message || '').slice(-2000)}`);
    const byOut = new Map(JSON.parse(r.stdout).map((x) => [x.out, x.range]));
    return jobs.map((j) => byOut.get(j.out) ?? null);
}

/** 把结果写回产物 index.json（有子集记 font_file／font_range，没有就去掉这两个键），并删掉不再需要的旧子集文件 */
export function applyFontResults(jobs, ranges) {
    const byIndex = new Map();
    jobs.forEach((j, i) => {
        if (!byIndex.has(j.indexPath)) byIndex.set(j.indexPath, { dir: j.dir, files: new Map() });
        byIndex.get(j.indexPath).files.set(j.file, ranges[i]);
    });
    let written = 0;
    for (const [indexPath, { dir, files }] of byIndex) {
        const raw = readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(raw);
        let changed = false;
        for (const ch of index.chapters) {
            if (!files.has(ch?.file)) continue;
            const range = files.get(ch.file);
            const file = range ? `${ch.file}${FONT_SUFFIX}` : undefined;
            if (range) written++;
            if (ch.font_file === file && ch.font_range === (range ?? undefined)) continue;
            changed = true;
            if (range) Object.assign(ch, { font_file: file, font_range: range });
            else { delete ch.font_file; delete ch.font_range; }
        }
        // 没有改动就不动文件（不改源仓的排版字节）
        if (changed) writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
        const keep = new Set([...files].filter(([, r]) => r).map(([f]) => `${f}${FONT_SUFFIX}`));
        for (const name of readdirSync(dir)) if (name.endsWith(FONT_SUFFIX) && !keep.has(name)) unlinkSync(join(dir, name));
    }
    return written;
}

/**
 * 准备一次：读 HANAMIN 段码位、载入转换器、检查依赖。
 * 依赖齐 → 返回 ctx；不齐 → KYG_CHAPTER_FONTS=required 时抛错，否则返回 { skip: '原因' }
 */
export async function chapterFontContext(env = process.env) {
    const required = env.KYG_CHAPTER_FONTS === 'required';
    const fail = (why) => {
        if (required) throw new Error(`对读章子集字体（GUJI-701）：${why}`);
        return { skip: why };
    };
    if (env.KYG_CHAPTER_FONTS === 'off') return { skip: 'KYG_CHAPTER_FONTS=off' };
    const hanaminDir = env.HANAMIN_DIR;
    if (!hanaminDir || !existsSync(join(hanaminDir, 'HanaMin.css'))) return fail('没设 HANAMIN_DIR（hanamin@0.0.5 包目录）或目录里没有 HanaMin.css');
    const python = env.KYG_FONT_PYTHON || 'python3';
    const probe = spawnSync(python, ['-c', 'import fontTools, brotli'], { encoding: 'utf-8' });
    if (probe.status !== 0) return fail(`${python} 缺 fonttools／brotli（pip install fonttools brotli）`);
    const ranges = hanaminRanges(readFileSync(resolve(__dirname, '..', '..', 'src', 'app', 'globals.css'), 'utf-8'));
    // 简体档：与网站同一个繁→简入口（异体归一＋opencc t2cn，overview#448 S0），不自己 new Converter
    const { toSimplified } = await import('./to-simplified.mjs');
    const variants = [(s) => s, (s) => toSimplified(s)];
    return { ranges, variants, hanaminDir, python };
}

/** 一个条目：收集、生成、写回；返回生成了子集的章数 */
export function buildItemFonts(itemOutDir, ctx) {
    const jobs = collectFontJobs(itemOutDir, ctx);
    if (jobs.length === 0) return 0;
    return applyFontResults(jobs, runFontJobs(jobs, ctx));
}
