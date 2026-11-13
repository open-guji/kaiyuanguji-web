/**
 * 人物（entities）文档的纯函数字段，不依赖 opencc 等包，方便 CI 直接 node --test。
 */

/**
 * 人物任官（book-index#2331）：分片里的 office_ids／office_place_ids 原样透传，只作 filter（「任过某官」「在某地任官」）。
 * 口径在 build 定：已解并条、沿 concept_id 展开跨朝上位条、排除赠官／不就；没任官的不写键，这里也不写。
 */
export function officeFields(entry) {
    return { ...idList('office_ids', entry?.office_ids), ...idList('office_place_ids', entry?.office_place_ids) };
}

function idList(key, v) {
    if (!Array.isArray(v)) return {};
    const ids = [...new Set(v.filter((x) => typeof x === 'string' && x))];
    return ids.length ? { [key]: ids } : {};
}
