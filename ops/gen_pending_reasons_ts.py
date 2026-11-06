"""guji-manager `python -m guji_manager.review.pending_reason --json` → pendingReasons.ts（网站、控制台共用一份）。"""
import json, sys
d = json.load(open(sys.argv[1]))
KEYS = ['code', 'category', 'route', 'label', 'hint', 'ui']
def js(v): return json.dumps(v, ensure_ascii=False)
out = ['''/**
 * 待审原因 PendingReason（sheldon 2026-11-03 定）：待审单每格的 `pending_reason`。
 * **真源在 guji-manager** `guji_manager/review/pending_reasons.yaml`；本文件由
 * `python -m guji_manager.review.pending_reason --json` 导出 JSON，再用 kaiyuanguji-web `ops/gen_pending_reasons_ts.py <json> <本文件>` 生成；改码表请改 guji-manager、再重新生成，别手改。
 * 每条上面的注释是 yaml 的 `detect`：这个原因在管线哪一步、按什么判出来的。
 * 不认识的值一律按 `unknown` 显示（不确定就写 unknown）。
 * 改过名的旧值（book-text 和已发的旧待审单里还有）经 PENDING_REASON_RENAMED 映射到新名。
 */''', f'export const PENDING_REASON_VERSION = {d["version"]};', 'export const PENDING_REASONS = {']
items = list(d['reasons'].items())
for i, (k, v) in enumerate(items):
    if v.get('detect'):
        out.append(f'    // {v["code"]} {k}：{v["detect"]}')
    body = ',\n'.join(f'        {js(kk)}: {js(v[kk])}' for kk in KEYS if kk in v)
    out.append(f'    {js(k)}: {{\n{body}\n    }}' + (',' if i < len(items) - 1 else ''))
out.append('} as const;')
out.append('export const REASON_CATEGORIES: Record<string, string> = {')
ct = list(d['categories'].items())
out += [f'    {js(a)}: {js(b["label"])}' + (',' if i < len(ct) - 1 else '') for i, (a, b) in enumerate(ct)]
out.append('};')
out.append('/** 旧名 → 新名（2026-11-06 Sheldon 定：P01 ref_replaced→ref_ocr_diff「识别字与参校本对位时就不同」，'
           'P02 ref_mismatch→ref_final_diff「对位一致、最后定字与参校本不同」）。读旧单时先换成新名 */')
out.append('export const PENDING_REASON_RENAMED: Record<string, PendingReason> = {')
ren = list(d.get('renamed', {}).items())
out += [f'    {js(a)}: {js(b)}' + (',' if i < len(ren) - 1 else '') for i, (a, b) in enumerate(ren)]
out.append('};')
out.append('export const REASON_ROUTES: Record<string, string> = {')
rt = list(d['routes'].items())
out += [f'    {js(a)}: {js(b if isinstance(b, str) else b.get("label", b))}' + (',' if i < len(rt) - 1 else '') for i, (a, b) in enumerate(rt)]
out.append('};')
out.append('''export type PendingReason = keyof typeof PENDING_REASONS;
export type ReasonSpec = (typeof PENDING_REASONS)[PendingReason];
export const UNKNOWN_REASON: PendingReason = 'unknown';
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export function parseReason(v: unknown): PendingReason {
    if (typeof v !== 'string') return UNKNOWN_REASON;
    if (has(PENDING_REASONS, v)) return v as PendingReason;
    if (has(PENDING_REASON_RENAMED, v)) return PENDING_REASON_RENAMED[v];
    return UNKNOWN_REASON;
}
export function reasonSpec(v: unknown): ReasonSpec {
    return PENDING_REASONS[parseReason(v)];
}''')
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
