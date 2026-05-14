/**
 * Draft → Production 升级映射的本地解析器。
 *
 * 与 book-index-ui/storage/promotions.ts 是等价复制：放在本地是为了避免
 * 跨包发布耦合（每次 promotions 改动都要等 book-index-ui 发版才能拿到）。
 *
 * 文件格式定义见：book_index_manager/promotion.py（Python 写出方）
 * 升级流程文档见：项目进展/古籍索引网站/整体设计/2026-05-Draft到Production升级流程.md
 */

export interface PromotionRecord {
    production_id: string;
    type: string;
    promoted_at: string;
}

export interface PromotionsFile {
    version: number;
    promotions: Record<string, PromotionRecord>;
}

/**
 * 把 promotions.json 原始内容转成 draft_id → production_id 扁平 Map。
 * 容错：缺字段、版本号不匹配都按空映射处理。
 */
export function buildPromotionMap(raw: unknown): Map<string, string> {
    const map = new Map<string, string>();
    if (!raw || typeof raw !== 'object') return map;

    const file = raw as Partial<PromotionsFile>;
    if (typeof file.version !== 'number') return map;
    if (file.version !== 1) {
        console.warn(`[promotions] unknown version ${file.version}; treating as empty`);
        return map;
    }

    const promotions = file.promotions;
    if (!promotions || typeof promotions !== 'object') return map;

    for (const [draftId, rec] of Object.entries(promotions)) {
        if (rec && typeof rec === 'object' && typeof (rec as PromotionRecord).production_id === 'string') {
            map.set(draftId, (rec as PromotionRecord).production_id);
        }
    }
    return map;
}
