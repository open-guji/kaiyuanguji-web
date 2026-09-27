/**
 * h1-promotions.mjs — 升格对照表（promotions.json，草稿 id → 正式 id）按分片进 h1（PH 道）
 *
 * 背景：条目页 SSR（W2-2）查不到草稿 id 时要知道它升格成了哪个正式 id，才能一跳
 * 308 过去。整张 promotions.json 曾有 14 万条、18.9 MB，函数里不能整表加载；
 * 这里把它按与 manifest **同一套分片规则**（id 末 2 位）拆开，分片按内容哈希命名、
 * 列进同一份 roots/<key>.json（字段 promotionShards），服务端一次只取一片（几 KB）。
 *
 * 分片内容是扁平的 { 草稿id: 正式id }——服务端只需要这一个字段，type／promoted_at
 * 不进分片（完整表仍在 current/promotions.json 给客户端用）。
 *
 * 纯函数，无副作用；写盘由 bundle-hashed.mjs 用 writeHashedShards 做。
 */

const ID_RE = /^[0-9a-z]{6,20}$/;

/**
 * 把 promotions.json 原始内容转成按后缀分片的扁平映射。
 * 格式与 src/lib/promotions.ts 的 buildPromotionMap 同一套容错：版本不是 1、
 * 缺字段的记录一律跳过；另外挡掉 id 形态不对与「自己升格成自己」的记录。
 *
 * @param {unknown} raw  promotions.json 解析后的对象
 * @param {number} shardKeyLength
 * @returns {{ shards: Record<string, Record<string, string>>, count: number, skipped: number }}
 */
export function buildPromotionShards(raw, shardKeyLength) {
    const shards = {};
    let count = 0;
    let skipped = 0;
    if (!raw || typeof raw !== 'object' || raw.version !== 1) {
        return { shards, count, skipped };
    }
    const promotions = raw.promotions && typeof raw.promotions === 'object' ? raw.promotions : {};
    // 按草稿 id 排序写入：分片内容（从而哈希）只取决于对照表本身，不受源文件键序影响
    for (const draftId of Object.keys(promotions).sort()) {
        const to = promotions[draftId]?.production_id;
        if (typeof to !== 'string' || !ID_RE.test(draftId) || !ID_RE.test(to) || to === draftId) {
            skipped++;
            continue;
        }
        (shards[draftId.slice(-shardKeyLength)] ??= {})[draftId] = to;
        count++;
    }
    return { shards, count, skipped };
}
