#!/usr/bin/env node
/**
 * 从 open-guji-cv 的 config/hanzi/core/edges.tsv 抽「对校」用的异体字小表 public/compare/glyph-variants.json。
 *
 * 用法：node scripts/build-glyph-variants.mjs <edges.tsv> [--sources=open|trusted|all] [--out=public/compare/glyph-variants.json]
 *
 * 判定（A41 对校设计 §8）：两字间有 variant / variant_partial / simp / z 边，且没有 distinct（人审定永不并）、
 * 也没有 borrow（通假，按/案、獨/猶，算「用字不同」）→ 异体字。related / spoof（形近）不算。
 * --sources：open＝只取许可明确开放的来源（Unihan、本项目自有、MIT 的 yi-bai）；trusted＝再加 cjkvi-variants 系、yitizi
 *   （许可标注不明，发布前要先确认，见 edges 同目录 sources.tsv 的 license 列）；all＝全部（含非商业的部件检索与字统网一跳族，不建议）。
 * 列：a b 关系 flag 来源 …（制表符，无表头）。表按字典序输出，结果稳定。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const edgesPath = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
if (!edgesPath) {
    console.error('用法：node scripts/build-glyph-variants.mjs <edges.tsv> [--sources=open|trusted|all] [--out=…]');
    process.exit(1);
}
const mode = opt('sources', 'open');
if (!['open', 'trusted', 'all'].includes(mode)) throw new Error(`--sources 只认 open|trusted|all，收到 ${mode}`);
const out = opt('out', 'public/compare/glyph-variants.json');

const VARIANT = new Set(['variant', 'variant_partial', 'simp', 'z']);
const isOpen = (src) => src.startsWith('unihan') || src.startsWith('local:keben') || src.startsWith('yibai');
// trusted：再加 cjkvi-variants 系与 yitizi（异体字典类来源，许可标注不明，发布前须确认）；all 另含部件检索（非商业）与字统网派生的一跳族
const isTrusted = (src) => isOpen(src) || ['yitizi', 'twedu', 'dypytz', 'hydzd', 'cjkvi-simplified'].includes(src);
const pick = { open: isOpen, trusted: isTrusted, all: () => true }[mode];
const key = (a, b) => (a < b ? `${a}\t${b}` : `${b}\t${a}`);

const yes = new Set();
const no = new Set();
const used = new Set();
for (const line of fs.readFileSync(edgesPath, 'utf8').split('\n')) {
    if (!line) continue;
    const [a, b, rel, , src] = line.split('\t');
    if (a === b || [...a].length !== 1 || [...b].length !== 1) continue;
    if (rel === 'distinct' || rel === 'borrow') no.add(key(a, b));
    else if (VARIANT.has(rel) && pick(src)) {
        yes.add(key(a, b));
        used.add(src);
    }
}
const pairs = [...yes].filter((k) => !no.has(k)).sort();
const table = {
    version: new Date().toISOString().slice(0, 10),
    sources: [...used].sort(),
    mode,
    pairs: pairs.map((k) => k.replace('\t', '')).join('\n'),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(table));
console.log(`${pairs.length} 对 → ${out}（${fs.statSync(out).size} 字节，来源 ${table.sources.join('、')}）`);
