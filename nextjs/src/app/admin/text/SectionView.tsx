'use client';

// 后台「文本整理」下各领域的栏目页（/admin/text/section?s=xingjin）：形近字、异体字组、人审……
// 数由负责领域的 job 写进 progress.metric；还没写的栏目显示占位和写法。
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Fragment, useMemo, useState } from 'react';
import { type Metric, type MetricTable, type Section, type Snapshot, cmpCell, fmtCell, fmtLA, fmtMetric, groupByBook, scopeOf, sectionsOf, tableOf } from './model';
import { DOC_URL, Freshness, LoadState, PageHeader, Panel, Stat } from './ui';
import { useTextProgress } from './useTextProgress';

export default function SectionView() {
  const slug = useSearchParams()?.get('s') || '';
  const load = useTextProgress();
  const snap = load.state === 'ok' ? load.snapshot : null;
  const section = sectionsOf(snap).find((s) => s.section === slug);

  if (load.state === 'ok' && !section) {
    return (
      <div className="space-y-5">
        <PageHeader title="没有这个栏目" />
        <Panel className="p-6 text-sm text-gray-500">
          栏目 <code>{slug || '（空）'}</code> 不在中心库 <code>progress.section</code> 里。<Link className="underline" href="/admin/text">回总览</Link>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={section?.title || '…'}
        sub={section && (
          <span className="inline-flex flex-wrap items-center gap-2">
            {section.owner && <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">{section.owner} 负责</span>}
            {section.description}
          </span>
        )}
        right={snap ? <Freshness snap={snap} /> : undefined}
      />
      {snap && section ? <SectionBody snap={snap} section={section} /> : <LoadState load={load} />}
    </div>
  );
}

function SectionBody({ snap, section }: { snap: Snapshot; section: Section }) {
  const metrics = useMemo(() => (snap.metrics || []).filter((m) => m.section === section.section), [snap.metrics, section.section]);
  const titles = useMemo(() => new Map(groupByBook(snap.volumes || []).map((g) => [g.book_id, g.title])), [snap.volumes]);
  if (!metrics.length) return <Placeholder section={section} />;

  const top = metrics.filter((m) => !m.vol).sort(bySort);
  const summary = top.filter((m) => !tableOf(m));
  const tables = top.filter((m) => tableOf(m));
  const perVol = metrics.filter((m) => m.vol);
  const latest = metrics.reduce<string | null>((a, m) => (m.at && (!a || m.at > a) ? m.at : a), null);
  const writers = [...new Set(metrics.map((m) => m.writer).filter(Boolean))].join('、');

  return (
    <>
      {summary.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {summary.map((m) => (
            <Stat key={`${m.book_id}/${m.key}`} label={m.label} value={fmtMetric(m)} hint={scopeOf(m, titles)} />
          ))}
        </div>
      )}
      {tables.map((m) => (
        <Panel key={`${m.book_id}/${m.key}`} className="overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-semibold">{m.label}</span>
            <span className="text-xs text-gray-400">{scopeOf(m, titles)}{m.value_text ? ` · ${m.value_text}` : ''}</span>
          </div>
          <DataTable table={tableOf(m)!} />
          {tableOf(m)!.note && <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400 whitespace-pre-line">{tableOf(m)!.note}</div>}
        </Panel>
      ))}
      {perVol.length > 0 && <PerVolume metrics={perVol} snap={snap} titles={titles} />}
      <div className="text-xs text-gray-400">
        写入：{writers || '—'} · 最近一次 {fmtLA(latest)}（洛杉矶时间）
        {section.section === 'jobs' && snap.live && (snap.live.ok ? ' · 实时读取' : ` · 实时读取失败（${snap.live.error || '未知'}），显示的是快照`)}
      </div>
    </>
  );
}

const bySort = (a: Metric, b: Metric) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label, 'zh');

/** 指标 detail.table 画成的表：点表头排序（再点倒序），行里有 _sub 的可点开看子表 */
function DataTable({ table, nested = false }: { table: MetricTable; nested?: boolean }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const rows = useMemo(() => {
    const list = table.rows.map((r, i) => ({ r, i }));
    if (sort) list.sort((a, b) => cmpCell(a.r[sort.key], b.r[sort.key]) * (sort.desc ? -1 : 1) || a.i - b.i);
    return list;
  }, [table.rows, sort]);
  const isNum = (key: string) => table.rows.some((r) => typeof r[key] === 'number');
  const click = (key: string) => setSort((s) => (s && s.key === key ? { key, desc: !s.desc } : { key, desc: isNum(key) }));
  const toggle = (i: number) => setOpen((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const hasSub = table.rows.some((r) => r._sub);
  return (
    <div className={nested ? 'overflow-x-auto' : 'overflow-x-auto max-h-[75vh]'}>
      <table className="min-w-full text-sm">
        <thead className={`${nested ? 'bg-gray-100/70' : 'bg-gray-50 sticky top-0 z-10'} text-xs text-gray-500 whitespace-nowrap`}>
          <tr>
            {hasSub && <th className="w-6" />}
            {table.columns.map((c, ci) => (
              <th key={c.key} title={c.hint || c.key} onClick={() => click(c.key)}
                className={`${isNum(c.key) ? 'text-right' : 'text-left'} font-medium px-3 ${ci === 0 && !hasSub ? 'pl-4' : ''} py-2 cursor-pointer select-none hover:text-gray-800`}>
                {c.label}{sort?.key === c.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(({ r, i }) => (
            <Fragment key={i}>
              <tr className={`hover:bg-gray-50/60 ${r._sub ? 'cursor-pointer' : ''}`} onClick={r._sub ? () => toggle(i) : undefined}>
                {hasSub && <td className="pl-3 text-xs text-gray-400">{r._sub ? (open.has(i) ? '▾' : '▸') : ''}</td>}
                {table.columns.map((c, ci) => (
                  <td key={c.key} className={isNum(c.key) ? 'px-3 py-1.5 text-right whitespace-nowrap tabular-nums' : `px-3 ${ci === 0 && !hasSub ? 'pl-4' : ''} py-1.5 text-left whitespace-nowrap`}>
                    {fmtCell(r[c.key], c.unit)}
                  </td>
                ))}
              </tr>
              {r._sub && open.has(i) && (
                <tr><td colSpan={table.columns.length + 1} className="bg-gray-50/60 px-4 py-2"><DataTable table={r._sub} nested /></td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 各册一行、各指标一列 */
function PerVolume({ metrics, snap, titles }: { metrics: Metric[]; snap: Snapshot; titles: Map<string, string> }) {
  const cols = useMemo(() => {
    const seen = new Map<string, Metric>();
    for (const m of [...metrics].sort(bySort)) if (!seen.has(m.key)) seen.set(m.key, m);
    // 数值列在前，文字列（备注、线上单号之类）排最后并左对齐，免得和数混排
    const isText = (m: Metric) => typeof m.value !== 'number';
    return [...seen.values()].sort((a, b) => Number(isText(a)) - Number(isText(b)));
  }, [metrics]);
  const colIsText = (c: Metric) => typeof c.value !== 'number';
  const volTitle = useMemo(() => new Map((snap.volumes || []).map((v) => [`${v.book_id}/${v.vol}`, v.vol_title || ''])), [snap.volumes]);
  const rows = useMemo(() => {
    const map = new Map<string, { book_id: string; vol: string; cells: Map<string, Metric> }>();
    for (const m of metrics) {
      const id = `${m.book_id}/${m.vol}`;
      if (!map.has(id)) map.set(id, { book_id: m.book_id, vol: m.vol, cells: new Map() });
      map.get(id)!.cells.set(m.key, m);
    }
    return [...map.values()].sort((a, b) => (a.book_id < b.book_id ? -1 : a.book_id > b.book_id ? 1 : a.vol < b.vol ? -1 : 1));
  }, [metrics]);

  return (
    <Panel className="overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold">各册</div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50/80 text-xs text-gray-500 whitespace-nowrap">
            <tr>
              <th className="text-left font-medium px-3 pl-4 py-2">书</th>
              <th className="text-left font-medium px-3 py-2">册</th>
              {cols.map((c) => <th key={c.key} className={`${colIsText(c) ? 'text-left' : 'text-right'} font-medium px-3 py-2`} title={c.key}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={`${r.book_id}/${r.vol}`} className="hover:bg-gray-50/60">
                <td className="px-3 pl-4 py-2 whitespace-nowrap text-gray-600">{titles.get(r.book_id) || r.book_id}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-mono">{r.vol}</span>
                  {volTitle.get(`${r.book_id}/${r.vol}`) && <span className="ml-2 text-xs text-gray-400">{volTitle.get(`${r.book_id}/${r.vol}`)}</span>}
                </td>
                {cols.map((c) => {
                  const m = r.cells.get(c.key);
                  return (
                    <td key={c.key} className={colIsText(c) ? 'px-3 py-2 text-left text-xs text-gray-500 max-w-xs truncate' : 'px-3 py-2 text-right whitespace-nowrap tabular-nums'} title={m ? `${m.writer || ''} · ${fmtLA(m.at)}${colIsText(c) ? ` · ${fmtMetric(m)}` : ''}` : ''}>
                      {m ? fmtMetric(m) : <span className="text-gray-300">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Placeholder({ section }: { section: Section }) {
  const who = section.owner || '负责领域';
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white/60 p-8 text-center">
      <div className="text-base font-medium text-gray-700">还没有数</div>
      <p className="mt-1 text-sm text-gray-500">这一栏留给 {who} 填。job 把数写进中心库 <code>progress.metric</code>（section = <code>{section.section}</code>），下一次同步后这里自动出现。</p>
      <pre className="mt-4 inline-block max-w-full overflow-x-auto rounded-lg bg-gray-50 px-3 py-2 text-left text-xs text-gray-600">
{`SELECT progress.put_metric('<书 id>', '<册，整套留空>', '${section.section}',
  '<key>', '<显示名>', <数值，比率写小数>, '<单位，比率写 %>', '${section.owner || '<领域>'}');`}
      </pre>
      <div className="mt-3 text-xs"><a className="underline text-gray-500" href={DOC_URL} target="_blank" rel="noreferrer">完整写法见 docs/text-progress.md</a></div>
    </div>
  );
}
