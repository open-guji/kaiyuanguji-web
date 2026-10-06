#!/usr/bin/env node
/**
 * 扫 book-text 里实际会显示的扩展区字，写成 ops/fonts/hanamin-used-chars.txt（overview#421）。
 *
 * 只收花园明朝兜底负责的区段：扩展 A（U+3400–4DBF）、扩展 B–F 与兼容补充（U+20000–2FA1F）、扩展 G（U+30000–3134F）、
 * 兼容表意文字（U+F900–FAFF）。
 *
 * 要算「读者实际看到的字」，不是原文里的字：站上默认简体，繁→简转换会把常用繁体生僻字换成扩展区简化字
 * （巘→𪩘、纚→𫄥、詀→𧮪、轇→𫐖、顗→𫖮 都是），异体字归一也会换字。所以每份文本取三种形态的并集：
 *   ① 原文；② 异体字归一后（book-index-ui/variant-chars.json，繁体显示用）；③ 归一后再 opencc-js t2cn（简体显示用）。
 * 转换口径与 src/lib/server/simplify.ts、book-index-ui 的 LocaleProvider 一致。
 *
 * 用法：
 *   node scripts/collect-hanamin-chars.mjs <book-text 目录>... [-o ../ops/fonts/hanamin-used-chars.txt]
 * 只读文件，不改 book-text。扫描 .json／.md／.txt／.tsv。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Converter } = require('opencc-js/t2cn');
const VARIANTS = require('book-index-ui/variant-chars.json');
const __dirname = dirname(fileURLToPath(import.meta.url));

const RANGES = [[0x3400, 0x4dbf], [0xf900, 0xfaff], [0x20000, 0x2fa1f], [0x30000, 0x3134f]];
const covered = (cp) => RANGES.some(([a, b]) => cp >= a && cp <= b);
const t2cn = Converter({ from: 't', to: 'cn' });
const normalizeVariants = (s) => { let o = ''; for (const ch of s) o += VARIANTS[ch] ?? ch; return o; };

const args = process.argv.slice(2);
let out = resolve(__dirname, '../../ops/fonts/hanamin-used-chars.txt');
const dirs = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') out = resolve(args[++i]);
    else dirs.push(args[i]);
}
if (dirs.length === 0) {
    console.error('用法：node scripts/collect-hanamin-chars.mjs <book-text 目录>... [-o 输出文件]');
    process.exit(1);
}

function* walk(d) {
    for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = statSync(p);
        if (st.isDirectory()) yield* walk(p);
        else if (/\.(json|md|txt|tsv)$/.test(n)) yield p;
    }
}

const used = new Set();
const fromRaw = new Set();
let files = 0;
for (const d of dirs) {
    for (const f of walk(d)) {
        let text;
        try { text = readFileSync(f, 'utf-8'); } catch { continue; }
        files++;
        const norm = normalizeVariants(text);
        for (const [form, isRaw] of [[text, true], [norm, false], [t2cn(norm), false]]) {
            for (const ch of form) {
                const cp = ch.codePointAt(0);
                if (!covered(cp)) continue;
                used.add(cp);
                if (isRaw) fromRaw.add(cp);
            }
        }
    }
}
const sorted = [...used].sort((a, b) => a - b);
writeFileSync(out, sorted.map((c) => String.fromCodePoint(c)).join('') + '\n', 'utf-8');
console.error(`扫了 ${files} 个文件，读者可能看到的扩展区字 ${sorted.length} 个（其中原文里就有 ${fromRaw.size} 个，其余是繁简／异体转换出来的）→ ${out}`);
