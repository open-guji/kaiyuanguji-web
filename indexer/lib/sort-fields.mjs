/**
 * 搜索页排序用的字段取值（overview#298）。full-reindex.mjs 一 import 就跑 main，所以取值逻辑单独成模块方便单测。
 */

// 搜索页 v4「按年代」排序（overview#298）：把朝代名映射成一个可排序的数字。顺序按通行的朝代先后，
// 同一朝代的细分（西漢／東漢、北宋／南宋）排在总名之后；不认识或为空的排在最后（升序时垫底）。
// 与 book-index-ui 的 DYNASTY_GROUPS 取值同源——新出现的朝代名要两边一起补。
export const DYNASTY_ORDER = [
    '先秦', '春秋', '戰國', '秦', '漢', '西漢', '東漢', '三國', '三國魏', '三國蜀', '三國吳', '晉', '西晉', '東晉',
    '南北朝', '南朝宋', '南朝齊', '南朝梁', '南朝陳', '北魏', '東魏', '西魏', '北齊', '北周', '隋', '唐', '五代',
    '前蜀', '後蜀', '南唐', '宋', '北宋', '南宋', '遼', '金', '宋末元初', '元', '元末明初', '明', '明末清初', '清', '民國',
];
export const ERA_RANK_UNKNOWN = 9999;
export function eraRank(name) {
    const i = DYNASTY_ORDER.indexOf((name || '').trim());
    return i < 0 ? ERA_RANK_UNKNOWN : i;
}

