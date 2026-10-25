'use client';

// 后台「文本整理」下各领域的栏目页（/admin/text/section?s=xingjin）：形近字、异体字组、人审……
// 数由负责领域的 job 写进 progress.metric；还没写的栏目显示占位和写法。
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { type Metric, type Section, type Snapshot, fmtLA, fmtMetric, groupByBook, scopeOf, sectionsOf } from './model';
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

  const summary = metrics.filter((m) => !m.vol).sort(bySort);
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
      {perVol.length > 0 && <PerVolume metrics={perVol} snap={snap} titles={titles} />}
      <div className="text-xs text-gray-400">写入：{writers || '—'} · 最近一次 {fmtLA(latest)}（洛杉矶时间）</div>
    </>
  );
}

const bySort = (a: Metric, b: Metric) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label, 'zh');

/** 各册一行、各指标一列 */
function PerVolume({ metrics, snap, titles }: { metrics: Metric[]; snap: Snapshot; titles: Map<string, string> }) {
  const cols = useMemo(() => {
    const seen = new Map<string, Metric>();
    for (const m of [...metrics].sort(bySort)) if (!seen.has(m.key)) seen.set(m.key, m);
    return [...seen.values()];
  }, [metrics]);
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
              {cols.map((c) => <th key={c.key} className="text-right font-medium px-3 py-2" title={c.key}>{c.label}</th>)}
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
                    <td key={c.key} className="px-3 py-2 text-right whitespace-nowrap tabular-nums" title={m ? `${m.writer || ''} · ${fmtLA(m.at)}` : ''}>
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
