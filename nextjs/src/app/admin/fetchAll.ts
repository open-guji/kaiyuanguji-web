// KV 列表按 key 升序返回，而 key 形如 `err_<毫秒>_…` / `fb_<毫秒>_…`——第一页是**最旧**的。
// 只取一页就会永远看不到最新的记录（旧 /toolkit/errors 取 limit=200 一页，超过 200 条后正是如此）。
// 所以管理页一律顺着 cursor 取完，再在前端按时间倒序。
export async function fetchAllPages<T>(
  baseUrl: string,
  pageSize: number,
  maxPages = 50,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    let j: { success?: boolean; error?: string; items?: T[]; cursor?: string; hasMore?: boolean };
    try { j = await res.json(); } catch { throw new Error(`HTTP ${res.status}`); }
    if (!j.success) throw new Error(j.error || `HTTP ${res.status}`);
    items.push(...(j.items || []));
    if (!j.hasMore || !j.cursor) return { items, truncated: false };
    cursor = j.cursor;
  }
  return { items, truncated: true };
}
