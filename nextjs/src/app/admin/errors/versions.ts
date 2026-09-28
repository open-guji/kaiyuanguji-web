// DBG：错误按版本归并——「错误出在哪一版代码、哪一版数据」。
// web = 网站代码 commit（前端构建时注入），data = 数据指针 commitId（latest.json）。
// 老记录（DBG 之前）没有 web/data，只有 release（= 数据版本），归到「代码版本未知」。

export interface VersionedError {
  kind: string;
  message: string;
  web?: string;
  data?: string;
  release?: string;
}

export interface VersionGroup {
  key: string;      // `${web}|${data}`，筛选用
  web: string;      // 12 位短 commit；空 = 未知
  data: string;     // 数据 commitId；空 = 未知
  count: number;
  top: { kind: string; message: string; count: number }[];
}

export function versionOf(e: VersionedError): { web: string; data: string } {
  return { web: (e.web || '').slice(0, 12), data: e.data || e.release || '' };
}

export function versionKey(e: VersionedError): string {
  const v = versionOf(e);
  return `${v.web}|${v.data}`;
}

/** 按 (web, data) 分组计数，每组列前 topN 种错误；组按条数降序。 */
export function groupByVersion(items: VersionedError[], topN = 3): VersionGroup[] {
  const groups = new Map<string, { web: string; data: string; count: number; msgs: Map<string, number> }>();
  for (const it of items) {
    const v = versionOf(it);
    const key = `${v.web}|${v.data}`;
    let g = groups.get(key);
    if (!g) { g = { ...v, count: 0, msgs: new Map() }; groups.set(key, g); }
    g.count += 1;
    const mk = `${it.kind}|${String(it.message || '').slice(0, 120)}`;
    g.msgs.set(mk, (g.msgs.get(mk) || 0) + 1);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      web: g.web,
      data: g.data,
      count: g.count,
      top: [...g.msgs.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([mk, count]) => { const i = mk.indexOf('|'); return { kind: mk.slice(0, i), message: mk.slice(i + 1), count }; }),
    }))
    .sort((a, b) => b.count - a.count);
}
