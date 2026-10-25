'use client';

// 后台「文本整理 · 总览」（A41，2026-10-25）。读 GET /api/text-progress（admin 成员 cookie），
// 那是定时任务从 Neon 中心库 progress schema 导出的快照；本页只读，不改任何数据。
// 总览看各套书、各册的基本进度；各领域自己填的数（形近字、异体字组、人审……）在左侧小标题下各占一页。
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  type Snapshot, type Stage, type VolumeRow,
  STAGE_HINT, STAGE_LABEL, STAGE_ORDER, ago, countStages, fmtInt, fmtLA, groupByBook, pendingIsRaw, sectionHref, sectionsOf, stageOf, writersOf,
} from './model';
import { DOC_URL, Freshness, LoadState, PageHeader, Panel, STAGE_BADGE, StageBar, StageLegend, Stat } from './ui';
import { useTextProgress } from './useTextProgress';

export default function TextProgressView() {
  const load = useTextProgress();
  const snap = load.state === 'ok' ? load.snapshot : null;
  return (
    <div className="space-y-5">
      <PageHeader
        title="总览"
        sub={<>各书、各册的整理进度。各领域的 job 写进中心库 <code>progress</code> 表，每 6 小时同步到这里。<a className="underline decoration-gray-300 hover:decoration-gray-500" href={DOC_URL} target="_blank" rel="noreferrer">口径与写法</a></>}
        right={snap ? <Freshness snap={snap} /> : undefined}
      />
      {snap ? <Overview snap={snap} /> : <LoadState load={load} />}
    </div>
  );
}

function Overview({ snap }: { snap: Snapshot }) {
  const [stageFilter, setStageFilter] = useState<Stage | 'all'>('all');
  const [onlyPending, setOnlyPending] = useState(false);
  const volumes = useMemo(() => snap.volumes || [], [snap.volumes]);
  const groups = useMemo(() => groupByBook(volumes), [volumes]);
  const stages = useMemo(() => countStages(volumes), [volumes]);
  const pending = groups.reduce((a, g) => a + g.pending, 0);
  const pendingVols = volumes.filter((v) => (v.pending_review ?? 0) > 0).length;
  const released = stages.released ?? 0;
  const problems = snap.collector?.problems || [];

  const keep = (v: VolumeRow) =>
    (stageFilter === 'all' || stageOf(v).stage === stageFilter) && (!onlyPending || (v.pending_review ?? 0) > 0);

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="在整理的套书" value={fmtInt(groups.length)} hint={`共 ${fmtInt(volumes.length)} 册`} />
        <Stat label="精校中" value={fmtInt(stages.fine ?? 0)} hint={`粗校 ${fmtInt(stages.rough ?? 0)} 册`} />
        <Stat label="已出 1.0" value={<>{fmtInt(released)}<span className="text-base text-gray-400 font-normal"> / {fmtInt(volumes.length)}</span></>}>
          <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${volumes.length ? (released / volumes.length) * 100 : 0}%` }} />
          </div>
        </Stat>
        <Stat label="待人审格" value={fmtInt(pending)} hint={`分布在 ${fmtInt(pendingVols)} 册`} />
      </div>

      <Panel className="p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">各阶段册数</h2>
          <span className="text-xs text-gray-400">没写阶段的按文本版本推断：0.x 精校，1.0 起算已出</span>
        </div>
        <StageBar stages={stages} total={volumes.length} />
        <StageLegend stages={stages} />
      </Panel>

      {problems.length > 0 && (
        <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3 text-xs text-amber-900">
          <div className="font-semibold mb-1">基础采集提示</div>
          <ul className="list-disc pl-5 space-y-0.5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">各册进度</h2>
          <div className="flex flex-wrap items-center gap-3">
            <StageFilter value={stageFilter} onChange={setStageFilter} stages={stages} />
            <label className="text-xs text-gray-600 flex items-center gap-1.5">
              <input type="checkbox" className="rounded" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              只看有待人审的
            </label>
          </div>
        </div>
        {groups.map((g) => {
          const rows = g.volumes.filter(keep);
          if (!rows.length) return null;
          return (
            <Panel key={g.book_id} className="overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold">{g.title}</span>
                  <span className="text-xs text-gray-400 font-mono">{g.book_id}</span>
                  <span className="text-xs text-gray-500 sm:ml-auto tabular-nums">
                    {g.volumes.length} 册 · 待人审 {fmtInt(g.pending)} 格
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1"><StageBar stages={g.stages} total={g.volumes.length} thin /></div>
                  <span className="text-xs text-gray-500 whitespace-nowrap">
                    {STAGE_ORDER.filter((s) => g.stages[s]).map((s) => `${STAGE_LABEL[s]} ${g.stages[s]}`).join(' · ')}
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <VolumeTable rows={rows} />
              </div>
            </Panel>
          );
        })}
        {volumes.some(pendingIsRaw) && (
          <p className="text-xs text-gray-400">带 ≈ 的待人审是线上待审单的原始格数，还没扣掉出单后已有人裁、现行文本里已没有的格，会比实际略多；精校（A32）写了的册以它的数为准。</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">整理过程数据</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {sectionsOf(snap).map((s) => {
            const n = (snap.metrics || []).filter((m) => m.section === s.section).length;
            return (
              <Link key={s.section} href={sectionHref(s.section)} className="group">
                <Panel className="p-4 h-full transition group-hover:ring-gray-300">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{s.title}</span>
                    <span className="text-gray-300 group-hover:text-gray-500">→</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">{s.owner ? `${s.owner} 填 · ` : ''}{n ? `${n} 项指标` : '还没有数'}</div>
                </Panel>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}

function StageFilter({ value, onChange, stages }: { value: Stage | 'all'; onChange: (s: Stage | 'all') => void; stages: Partial<Record<Stage, number>> }) {
  const opts: (Stage | 'all')[] = ['all', ...STAGE_ORDER.filter((s) => stages[s])];
  return (
    <div role="radiogroup" aria-label="按阶段筛选" className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={`px-2.5 py-1 rounded-md ${value === o ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-800'}`}
        >
          {o === 'all' ? '全部' : STAGE_LABEL[o]}
        </button>
      ))}
    </div>
  );
}

function StageBadge({ v }: { v: VolumeRow }) {
  const { stage, derived } = stageOf(v);
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs ${STAGE_BADGE[stage]} ${derived ? 'border-dashed' : ''}`}
      title={`${STAGE_HINT[stage]}${derived ? '（按文本版本推断；领域写了 stage 就以它为准）' : ''}`}
    >
      {STAGE_LABEL[stage]}
    </span>
  );
}

const dash = <span className="text-gray-300">—</span>;
const verOr = (v: string | null | undefined) => (v ? <span className="font-mono">{v}</span> : dash);
const TH = 'text-left font-medium px-3 py-2';
const RAW_HINT = '网站按线上待审单的格数直接数的，没扣出单后已有人裁、现行文本里已没有的格，会比实际略多；精校（A32）按自己的口径写了就以它为准';

function VolumeTable({ rows }: { rows: VolumeRow[] }) {
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-gray-50/80 text-xs text-gray-500 whitespace-nowrap">
        <tr>
          <th className={`${TH} pl-4`}>册</th>
          <th className={TH}>卷次</th>
          <th className={TH}>阶段</th>
          <th className={TH}>文本</th>
          <th className={TH}>标点</th>
          <th className={TH}>专名</th>
          <th className={`${TH} text-right`}>待人审</th>
          <th className={TH}>待审单</th>
          <th className={TH}>cv</th>
          <th className={TH}>备注</th>
          <th className={`${TH} pr-4`}>更新</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((v) => {
          const writers = writersOf(v);
          return (
            <tr key={`${v.book_id}/${v.vol}`} className="align-top hover:bg-gray-50/60">
              <td className="px-3 pl-4 py-2 whitespace-nowrap">
                <span className="font-mono">{v.vol}</span>
                {v.cv_book && v.cv_book !== v.vol && <span className="ml-1 text-xs text-gray-400 font-mono">{v.cv_book}</span>}
              </td>
              <td className="px-3 py-2 max-w-[16rem] truncate" title={v.vol_title || ''}>{v.vol_title || dash}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                <StageBadge v={v} />
                {v.frozen_version && (
                  <span className="ml-1 text-xs text-gray-500" title="册 yaml 记了冻结：默认不重跑">冻结 {v.frozen_version}</span>
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {verOr(v.text_version)}
                {v.proofing && <span className="ml-1 text-xs text-sky-700" title="章条目 proofing: true，精校页开着">校</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {v.punct_version ? verOr(v.punct_version) : v.punct_status ? <span className="text-xs">{v.punct_status}</span> : dash}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{verOr(v.entity_version)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                {typeof v.pending_review === 'number'
                  ? <span title={pendingIsRaw(v) ? RAW_HINT : ''}>
                      {pendingIsRaw(v) && <span className="text-gray-400 font-normal">≈</span>}
                      <span className={v.pending_review > 0 ? 'font-semibold' : 'text-gray-400'}>{fmtInt(v.pending_review)}</span>
                    </span>
                  : dash}
                {typeof v.cells_total === 'number' && <span className="text-xs text-gray-400"> / {fmtInt(v.cells_total)}</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-xs">
                {v.pending_rev
                  ? <span title={`出单 ${fmtLA(v.pending_at, true)}（洛杉矶）`}><span className="font-mono">{v.pending_rev}</span>{v.pending_at && <span className="text-gray-400"> · {fmtLA(v.pending_at).slice(0, 5)}</span>}</span>
                  : dash}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-xs" title={[v.corpus && `语料 ${v.corpus}`, v.glyph_pin && `字形库 g${v.glyph_pin}`].filter(Boolean).join('，')}>
                {verOr(v.cv_version)}
              </td>
              <td className="px-3 py-2 text-xs max-w-[16rem]">{v.note || (typeof v.human_judged === 'number' ? `已人裁 ${fmtInt(v.human_judged)} 格` : dash)}</td>
              <td className="px-3 pr-4 py-2 whitespace-nowrap text-xs text-gray-400" title={writers.length ? `写入方：${writers.join('、')}` : ''}>
                {ago(v.updated_at)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
