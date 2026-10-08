/**
 * 全站唯一的「繁→简」转换逻辑（overview#448 S0）。纯函数、不 import 任何包，转换器与异体字表由调用方注入——
 * 这样网站服务端（lib/server/simplify.ts）、构建脚本（scripts/*.mjs）、搜索索引（indexer/）用的是同一份代码，
 * 将来 #446 全文检索也只经它。indexer 随 tar 单独部署、不能 import 网站目录，所以另存一份逐字相同的副本
 * （indexer/lib/to-simplified-core.mjs），由单测比对，改一处必须改两处。
 *
 * 口径（方案 §三、§四，用户 10-07 按推荐定）：
 *   - 只做 异体字归一 → opencc-js 的 t2cn（`Converter({ from: 't', to: 'cn' })`）。不用 tw2s、不用 *p 预设（会改字数、做词汇替换，
 *     「著録」会被转成「着录」，#368）；存储文本绝不做 s2t（会把「于云余后」等本字改错）。
 *   - 转换前后码点数必须相等：简体串的下标就是原文下标，检索命中能直接映回原文（#446）。
 *     t2cn 在样本 462 章上一直满足；万一某次升级或某个词条打破了它，退回逐码点转换（保证等长），仍不等长就只做异体字归一。
 *   - opencc-js 版本两处（nextjs、indexer）都钉死 1.0.5，升级须同时改并跑快照测试。
 */

/** 码点数（不是 UTF-16 长度；扩展区字占两个 UTF-16 单元） */
export function codePointLength(text) {
    let n = 0;
    for (const _ of text) n++;
    return n;
}

/** 转换前后码点数相等的断言：不等就抛错（测试与脚本里用；运行时的退路在 createToSimplified 里） */
export function assertSameLength(before, after) {
    const a = codePointLength(before);
    const b = codePointLength(after);
    if (a !== b) throw new Error(`繁简转换改变了长度：${a} → ${b}（${JSON.stringify(before.slice(0, 40))}）`);
    return after;
}

/** 异体字 → 正字（按码位，含扩展区字）；没有异体字时原样返回 */
export function normalizeVariants(text, variants) {
    let out = '';
    let changed = false;
    for (const ch of text) {
        const to = variants[ch];
        if (to !== undefined) changed = true;
        out += to ?? ch;
    }
    return changed ? out : text;
}

/**
 * @param {{ createConverter: () => (text: string) => string, variants: Readonly<Record<string, string>>, warn?: (msg: string) => void }} deps
 * @returns {(text: string) => string}  繁体（或简繁混排）→ 简体；转换器建不出来就原样返回
 */
export function createToSimplified({ createConverter, variants, warn = console.warn }) {
    let convert; // undefined 还没建；null 建失败
    const get = () => {
        if (convert !== undefined) return convert;
        try {
            convert = createConverter();
        } catch (err) {
            warn(`[to-simplified] 建繁简转换器失败，原样返回：${err.message}`);
            convert = null;
        }
        return convert;
    };
    let warned = false;

    return function toSimplified(text) {
        if (!text) return text;
        const c = get();
        if (!c) return text;
        try {
            const normalized = normalizeVariants(text, variants);
            const out = c(normalized);
            if (codePointLength(out) === codePointLength(normalized)) return out;
            if (!warned) {
                warned = true;
                warn('[to-simplified] opencc 转换改变了长度，退回逐码点转换（简体下标须等于原文下标）');
            }
            let perChar = '';
            for (const ch of normalized) perChar += c(ch);
            return codePointLength(perChar) === codePointLength(normalized) ? perChar : normalized;
        } catch {
            return text;
        }
    };
}
