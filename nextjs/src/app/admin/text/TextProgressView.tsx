'use client';

// 后台「文本整理」栏目（A41，2026-10-25）。读 GET /api/text-progress（admin 成员 cookie），
// 那是定时任务从 Neon 中心库 progress schema 导出的快照；本页只读，不改任何数据。
// 第一部分：一册一行的基本进度；第二部分：各领域自己填的数（形近字、异体字组、人审……），没填的留好位置。
import { useEffect, useMemo, useState } from 'react';
import {
  type Metric, type Section, type Snapshot, type Stage, type VolumeRow,
  STAGE_HINT, STAGE_LABEL, STAGE_ORDER, ago, fmtInt, fmtLA, fmtMetric, groupByBook, isStale, scopeOf, stageOf, writersOf,
} from './model';

const DOC_URL = 'https://github.com/open-guji/kaiyuanguji-web/blob/main/docs/text-progress.md';

const STAGE_STYLE: Record<Stage, string> = {
  todo: 'bg-gray-100 text-gray-600 border-gray-200',
  pipeline: 'bg-gray-100 text-gray-700 border-gray-300',
  rough: 'bg-amber-50 text-amber-800 border-amber-300',
  fine: 'bg-sky-50 text-sky-800 border-sky-300',
  released: 'bg-emerald-50 text-emerald-800 border-emerald-300',
};

type Load = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; snapshot: Snapshot | null; storedAt?: string };

export default function TextProgressView() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [stageFilter, setStageFilter] = useState<Stage | 'all'>('all');
  const [onlyPending, setOnlyPending] = useState(false);

  useEffect(() => {
    fetch('/api/text-progress', { credentials: 'include', cache: 'no-store' })
      .then(async (r) => {
        let j: { success?: boolean; error?: string; snapshot?: Snapshot | null; stored_at?: string };
        try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
        if (!j.success) throw new Error(j.error || `HTTP ${r.status}`);
        setLoad({ state: 'ok', snapshot: j.snapshot ?? null, storedAt: j.stored_at });
      })
      .catch((e: unknown) => setLoad({ state: 'error', error: e instanceof Error ? e.message : String(e) }));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">文本整理</h1>
        <p className="text-sm text-gray-500 mt-1">
          各书、各册的整理进度。数据由各领域的 job 写进中心库（Neon）<code>progress</code> 表，每小时同步到这里，会有延迟。
          口径与写法见 <a className="underline" href={DOC_URL} target="_blank" rel="noreferrer">docs/text-progress.md</a>。
        </p>
      </div>
      {load.state === 'loading' && <div className="p-8 text-center text-gray-500">读取中…</div>}
      {load.state === 'error' && (
        <div className="bg-white rounded border p-4 text-sm text-red-600">取数失败：{load.error}</div>
      )}
      {load.state === 'ok' && !load.snapshot && (
        <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">
          还没有数据：定时同步（Actions 里的 <code>text-progress</code>）还没跑过，或中心库的 <code>progress</code> 表还没建。
        </div>
      )}
      {load.state === 'ok' && load.snapshot && (
        <Body
          snap={load.snapshot}
          stageFilter={stageFilter}
          setStageFilter={setStageFilter}
          onlyPending={onlyPending}
          setOnlyPending={setOnlyPending}
        />
      )}
    </div>
  );
}

function Body({ snap, stageFilter, setStageFilter, onlyPending, setOnlyPending }: {
  snap: Snapshot;
  stageFilter: Stage | 'all';
  setStageFilter: (s: Stage | 'all') => void;
  onlyPending: boolean;
  setOnlyPending: (b: boolean) => void;
}) {
  const groups = useMemo(() => groupByBook(snap.volumes || []), [snap.volumes]);
  const titles = useMemo(() => new Map(groups.map((g) => [g.book_id, g.title])), [groups]);
  const totals = useMemo(() => {
    const stages: Partial<Record<Stage, number>> = {};
    let pending = 0;
    for (const g of groups) {
      pending += g.pending;
      for (const [s, n] of Object.entries(g.stages)) stages[s as Stage] = (stages[s as Stage] ?? 0) + (n ?? 0);
    }
    return { books: groups.length, vols: snap.volumes.length, pending, stages };
  }, [groups, snap.volumes.length]);
  const problems = snap.collector?.problems || [];
  const stale = isStale(snap.generated_at);

  const keep = (v: VolumeRow) =>
    (stageFilter === 'all' || stageOf(v).stage === stageFilter) && (!onlyPending || (v.pending_review ?? 0) > 0);

  return (
    <>
      <div className={`text-xs ${stale ? 'text-amber-700' : 'text-gray-500'}`}>
        快照生成于 {fmtLA(snap.generated_at)}（洛杉矶时间，{ago(snap.generated_at)}）
        {snap.collector?.at && <>；基础采集 {fmtLA(snap.collector.at)}</>}
        {stale && <>。已超过 6 小时没更新，看一下 Actions 里的 text-progress 有没有在跑。</>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card label="套书" value={`${totals.books} 部`} />
        <Card label="册" value={`${totals.vols} 册`} />
        <Card label="待人审格（合计）" value={fmtInt(totals.pending)} />
        <Card
          label="各阶段册数"
          value={STAGE_ORDER.filter((s) => totals.stages[s]).map((s) => `${STAGE_LABEL[s]} ${totals.stages[s]}`).join(' · ') || '—'}
          small
        />
      </div>

      {problems.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
          <div className="font-semibold mb-1">基础采集提示</div>
          <ul className="list-disc pl-5 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">一、各册进度</h2>
          <label className="text-sm text-gray-600 flex items-center gap-1">
            阶段
            <select
              aria-label="按阶段筛选"
              className="border rounded px-1 py-0.5 text-sm"
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value as Stage | 'all')}
            >
              <option value="all">全部</option>
              {STAGE_ORDER.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-600 flex items-center gap-1">
            <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
            只看有待人审的
          </label>
        </div>
        {groups.map((g) => {
          const rows = g.volumes.filter(keep);
          if (!rows.length) return null;
          return (
            <div key={g.book_id} className="bg-white rounded border">
              <div className="px-3 py-2 border-b flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold">{g.title}</span>
                <span className="text-xs text-gray-400 font-mono">{g.book_id}</span>
                <span className="text-xs text-gray-500">
                  {g.volumes.length} 册 · 待人审 {fmtInt(g.pending)} 格 ·{' '}
                  {STAGE_ORDER.filter((s) => g.stages[s]).map((s) => `${STAGE_LABEL[s]} ${g.stages[s]}`).join(' · ')}
                </span>
              </div>
              <div className="overflow-x-auto">
                <VolumeTable rows={rows} />
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">二、整理过程数据</h2>
        <p className="text-sm text-gray-500">
          各领域自己的数，写进 <code>progress.metric</code> 就出现在对应栏目里；还没写的栏目先留着位置。
        </p>
        {(snap.sections || []).map((s) => (
          <SectionCard key={s.section} section={s} metrics={(snap.metrics || []).filter((m) => m.section === s.section)} titles={titles} />
        ))}
      </section>
    </>
  );
}

function Card({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="bg-white rounded border p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={small ? 'text-sm mt-1' : 'text-xl font-mono mt-1'}>{value}</div>
    </div>
  );
}

function StageBadge({ v }: { v: VolumeRow }) {
  const { stage, derived } = stageOf(v);
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STAGE_STYLE[stage]} ${derived ? 'border-dashed' : ''}`}
      title={`${STAGE_HINT[stage]}${derived ? '（按文本版本推断；领域写了 stage 就以它为准）' : ''}`}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

const dash = <span className="text-gray-300">—</span>;
const verOr = (v: string | null | undefined) => (v ? <span className="font-mono">{v}</span> : dash);

function VolumeTable({ rows }: { rows: VolumeRow[] }) {
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-gray-50 text-xs text-gray-500 whitespace-nowrap">
        <tr>
          <th className="text-left font-normal px-3 py-1.5">册</th>
          <th className="text-left font-normal px-3 py-1.5">卷次</th>
          <th className="text-left font-normal px-3 py-1.5">阶段</th>
          <th className="text-left font-normal px-3 py-1.5">文本</th>
          <th className="text-left font-normal px-3 py-1.5">标点</th>
          <th className="text-left font-normal px-3 py-1.5">专名</th>
          <th className="text-right font-normal px-3 py-1.5">待人审</th>
          <th className="text-left font-normal px-3 py-1.5">待审单</th>
          <th className="text-left font-normal px-3 py-1.5">cv</th>
          <th className="text-left font-normal px-3 py-1.5">备注</th>
          <th className="text-left font-normal px-3 py-1.5">更新</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => {
          const writers = writersOf(v);
          return (
            <tr key={`${v.book_id}/${v.vol}`} className="border-t align-top">
              <td className="px-3 py-1.5 whitespace-nowrap">
                <span className="font-mono">{v.vol}</span>
                {v.cv_book && v.cv_book !== v.vol && <span className="ml-1 text-xs text-gray-400 font-mono">{v.cv_book}</span>}
              </td>
              <td className="px-3 py-1.5 max-w-[11rem] truncate" title={v.vol_title || ''}>{v.vol_title || dash}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <StageBadge v={v} />
                {v.frozen_version && (
                  <span className="ml-1 text-xs text-gray-500" title="册 yaml 记了冻结：默认不重跑">冻结 {v.frozen_version}</span>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {verOr(v.text_version)}
                {v.proofing && <span className="ml-1 text-xs text-sky-700" title="章条目 proofing: true，精校页开着">校</span>}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {v.punct_version ? verOr(v.punct_version) : v.punct_status ? <span className="text-xs">{v.punct_status}</span> : dash}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">{verOr(v.entity_version)}</td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap font-mono">
                {typeof v.pending_review === 'number'
                  ? <span className={v.pending_review > 0 ? 'font-semibold' : 'text-gray-400'}>{fmtInt(v.pending_review)}</span>
                  : dash}
                {typeof v.cells_total === 'number' && <span className="text-xs text-gray-400"> / {fmtInt(v.cells_total)}</span>}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs">
                {v.pending_rev
                  ? <span title={`出单 ${fmtLA(v.pending_at, true)}（洛杉矶）`}><span className="font-mono">{v.pending_rev}</span>{v.pending_at && <span className="text-gray-400"> · {fmtLA(v.pending_at).slice(0, 5)}</span>}</span>
                  : dash}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs" title={[v.corpus && `语料 ${v.corpus}`, v.glyph_pin && `字形库 g${v.glyph_pin}`].filter(Boolean).join('，')}>
                {verOr(v.cv_version)}
              </td>
              <td className="px-3 py-1.5 text-xs max-w-[16rem]">{v.note || (typeof v.human_judged === 'number' ? `已人裁 ${fmtInt(v.human_judged)} 格` : dash)}</td>
              <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-400" title={writers.length ? `写入方：${writers.join('、')}` : ''}>
                {ago(v.updated_at)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SectionCard({ section, metrics, titles }: { section: Section; metrics: Metric[]; titles: Map<string, string> }) {
  const latest = metrics.reduce<string | null>((a, m) => (m.at && (!a || m.at > a) ? m.at : a), null);
  return (
    <div className="bg-white rounded border">
      <div className="px-3 py-2 border-b flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-semibold">{section.title}</span>
        {section.owner && <span className="text-xs rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">{section.owner} 填</span>}
        {section.description && <span className="text-xs text-gray-500">{section.description}</span>}
        {latest && <span className="text-xs text-gray-400 ml-auto">更新 {fmtLA(latest)}</span>}
      </div>
      {metrics.length === 0 ? (
        <div className="px-3 py-4 text-sm text-gray-400">
          还没有数。{section.owner || '负责领域'}的 job 写进 <code>progress.metric</code>（section = <code>{section.section}</code>）后，这里自动出现。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left font-normal px-3 py-1.5">范围</th>
                <th className="text-left font-normal px-3 py-1.5">指标</th>
                <th className="text-right font-normal px-3 py-1.5">值</th>
                <th className="text-left font-normal px-3 py-1.5">写入</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={`${m.book_id}/${m.vol}/${m.key}`} className="border-t">
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-600">{scopeOf(m, titles)}</td>
                  <td className="px-3 py-1.5">{m.label}</td>
                  <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{fmtMetric(m)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-gray-400">{m.writer} · {fmtLA(m.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
