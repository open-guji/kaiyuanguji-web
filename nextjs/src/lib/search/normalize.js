// @ts-check
/**
 * 搜索规范化管道（构建期 Node 与浏览器 Worker 共用同一份代码）。
 *
 * 管道: 输入 → toLowerCase → 去标点空白。繁简转换在外层做。
 * 分词:
 *   - CJK 连续段：若长度 ≥2，产出全部 bigram；若长度 =1（单字标题/查询），产出 unigram 兜底
 *   - ASCII 连续段：整段一个 token
 *
 * 必须保证同一字符串在构建和查询两端输出一致 —— 否则命中率会静默下降。
 */

const PUNCT_RE = /[\s　\p{P}\p{S}]+/gu;
const CJK_RE = /[㐀-鿿豈-﫿]/;

/** @param {string} ch */
function isCjk(ch) {
    return CJK_RE.test(ch);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function clean(text) {
    if (!text) return '';
    return text.toLowerCase().replace(PUNCT_RE, '');
}

/**
 * 纯 bigram 分词 + CJK 单字段兜底。
 * 例:
 *   "孟子正義" → ["孟子","子正","正義"]
 *   "易"       → ["易"]           （单字兜底）
 *   "a 孟 b"   → ["a","孟","b"]   （单字 CJK 段兜底）
 *   "a孟子b"   → ["a","孟子","b"]
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    if (!text) return [];
    const cleaned = clean(text);
    if (!cleaned) return [];

    /** @type {string[]} */
    const tokens = [];
    /** @type {string[]} */
    let cjkBuf = [];
    let asciiBuf = '';

    const flushCjk = () => {
        if (cjkBuf.length === 0) return;
        if (cjkBuf.length === 1) {
            tokens.push(cjkBuf[0]);
        } else {
            for (let i = 0; i < cjkBuf.length - 1; i++) {
                tokens.push(cjkBuf[i] + cjkBuf[i + 1]);
            }
        }
        cjkBuf = [];
    };
    const flushAscii = () => {
        if (asciiBuf) {
            tokens.push(asciiBuf);
            asciiBuf = '';
        }
    };

    for (const ch of Array.from(cleaned)) {
        if (isCjk(ch)) {
            flushAscii();
            cjkBuf.push(ch);
        } else {
            flushCjk();
            asciiBuf += ch;
        }
    }
    flushCjk();
    flushAscii();

    return tokens;
}

/**
 * 判断 query 切出的 tokens 里是否含 CJK bigram。
 * 没有 bigram（即只有单字 unigram 兜底）时，查询端应开 prefix:true 以让 MiniSearch
 * 把"孟"展开为索引里所有"孟X"的 bigram。
 * @param {string[]} tokens
 */
export function hasCjkBigram(tokens) {
    for (const t of tokens) {
        if (Array.from(t).length >= 2) {
            // 检查首字是否 CJK（ASCII 段也可能 len>=2，不算 CJK bigram）
            if (isCjk(t[0])) return true;
        }
    }
    return false;
}

/**
 * 拼接多个字段为喂给 MiniSearch 的文本串。
 * @param {Array<string | undefined | null>} texts
 * @returns {string}
 */
export function joinFields(texts) {
    return texts.filter(Boolean).join(' ');
}
