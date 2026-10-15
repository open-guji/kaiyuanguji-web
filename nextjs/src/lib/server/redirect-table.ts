/**
 * 旧→新 ID 全表的「读表」接口（GUJI-355）。
 *
 * 表由数据侧（Eric）脚本产出：old_id → 最终存活 id，链已折叠、已防环。
 * 这里只定义中间件怎么读；文件名、分片方式、字段以 Eric 在 GUJI-355 定下的为准，
 * 定下后只需改 parseRedirectTable／加载处，查表接口 RedirectTable 不变。
 * 临时格式（假数据用）：{ version: 1, redirects: { "<旧id>": "<终点id>" | { to: "<终点id>" } } }
 *
 * 纯函数、无 IO，边缘运行时可用。
 */
import { isValidItemId } from '../item-id';

export interface RedirectTable {
    /** 旧 id 的终点；不在表里、终点非法或指向自己 → null（交回现有实时逻辑） */
    lookup(id: string): string | null;
    readonly size: number;
}

export const EMPTY_REDIRECT_TABLE: RedirectTable = { lookup: () => null, size: 0 };

export function parseRedirectTable(raw: unknown): RedirectTable {
    if (!raw || typeof raw !== 'object') return EMPTY_REDIRECT_TABLE;
    const file = raw as { version?: unknown; redirects?: unknown };
    if (file.version !== 1 || !file.redirects || typeof file.redirects !== 'object') return EMPTY_REDIRECT_TABLE;
    const map = new Map<string, string>();
    for (const [from, v] of Object.entries(file.redirects as Record<string, unknown>)) {
        const to = typeof v === 'string' ? v : (v as { to?: unknown } | null)?.to;
        if (typeof to === 'string' && to !== from && isValidItemId(from) && isValidItemId(to)) map.set(from, to);
    }
    return {
        size: map.size,
        lookup(id) {
            const to = map.get(id);
            // 表本应已折叠到终点；终点自己又在表里说明表有问题（多跳或环）→ 不信，交回实时逻辑
            return to && !map.has(to) ? to : null;
        },
    };
}
