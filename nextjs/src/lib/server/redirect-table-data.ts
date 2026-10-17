/**
 * 旧→新 ID 全表（GUJI-355）：打进中间件包的快照，命中即 308，不发取数。
 * 数据来自 book-index `scripts/build-id-table.py` 的输出（redirects.json，格式见 redirect-table.ts）。
 * 表只是加速：不在表里的旧 id 仍走 item-redirect 的实时逻辑，所以表旧了不会错跳，只是少跳。
 * 刷新：用当天 book-index main 重跑脚本，覆盖 redirect-table.data.json，跑 redirect-table.test.ts。
 */
import raw from './redirect-table.data.json';
import { parseRedirectTable } from './redirect-table';

export const ITEM_REDIRECT_TABLE = parseRedirectTable(raw);
