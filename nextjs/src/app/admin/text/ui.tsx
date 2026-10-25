'use client';

// 「文本整理」各页共用的小部件：页头、快照新鲜度、卡片、阶段色条
import type { ReactNode } from 'react';
import { type Snapshot, type Stage, STAGE_HINT, STAGE_LABEL, STAGE_ORDER, ago, fmtLA, isStale } from './model';
import type { Load } from './useTextProgress';

export const DOC_URL = 'https://github.com/open-guji/kaiyuanguji-web/blob/main/docs/text-progress.md';

/** 阶段的色：灰（没开工／跑管线）→ 琥珀（粗校）→ 蓝（精校）→ 绿（已出 1.0） */
export const STAGE_BAR: Record<Stage, string> = {
  todo: 'bg-gray-200',
  pipeline: 'bg-gray-400',
  rough: 'bg-amber-400',
  fine: 'bg-sky-500',
  released: 'bg-emerald-500',
};

export const STAGE_BADGE: Record<Stage, string> = {
  todo: 'bg-gray-100 text-gray-600 border-gray-200',
  pipeline: 'bg-gray-100 text-gray-700 border-gray-300',
  rough: 'bg-amber-50 text-amber-800 border-amber-300',
  fine: 'bg-sky-50 text-sky-800 border-sky-300',
  released: 'bg-emerald-50 text-emerald-800 border-emerald-300',
};

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl ring-1 ring-gray-200 shadow-sm ${className}`}>{children}</div>;
}

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <div className="text-xs text-gray-400">文本整理</div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <div className="text-sm text-gray-500 mt-1">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

/** 快照什么时候生成的：绿点＝新鲜，琥珀点＝超过 6 小时没更新 */
export function Freshness({ snap }: { snap: Snapshot }) {
  const stale = isStale(snap.generated_at);
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ${stale ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-white text-gray-600 ring-gray-200'}`}
      title={`快照生成于 ${fmtLA(snap.generated_at, true)}（洛杉矶时间）${snap.collector?.at ? `；基础采集 ${fmtLA(snap.collector.at, true)}` : ''}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      {stale ? `${ago(snap.generated_at)}更新，超过 6 小时没同步` : `${ago(snap.generated_at)}更新 · ${fmtLA(snap.generated_at)}`}
    </div>
  );
}

export function Stat({ label, value, hint, children }: { label: string; value: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <Panel className="p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-400">{hint}</div>}
      {children}
    </Panel>
  );
}

/** 各阶段册数的分段色条 */
export function StageBar({ stages, total, thin }: { stages: Partial<Record<Stage, number>>; total: number; thin?: boolean }) {
  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-gray-100 ${thin ? 'h-1.5' : 'h-2.5'}`} role="img"
      aria-label={STAGE_ORDER.filter((s) => stages[s]).map((s) => `${STAGE_LABEL[s]} ${stages[s]}`).join('，')}>
      {total > 0 && STAGE_ORDER.filter((s) => stages[s]).map((s) => (
        <div key={s} className={STAGE_BAR[s]} style={{ width: `${((stages[s] ?? 0) / total) * 100}%` }} title={`${STAGE_LABEL[s]} ${stages[s]} 册`} />
      ))}
    </div>
  );
}

export function StageLegend({ stages }: { stages: Partial<Record<Stage, number>> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
      {STAGE_ORDER.map((s) => (
        <span key={s} className={`inline-flex items-center gap-1.5 ${stages[s] ? '' : 'text-gray-300'}`} title={STAGE_HINT[s]}>
          <span className={`h-2 w-2 rounded-sm ${STAGE_BAR[s]}`} />
          {STAGE_LABEL[s]} <span className="tabular-nums font-medium">{stages[s] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

/** 读取中／取数失败／还没有快照 */
export function LoadState({ load }: { load: Load }) {
  if (load.state === 'loading') return <Panel className="p-10 text-center text-sm text-gray-400">读取中…</Panel>;
  if (load.state === 'error') return <Panel className="p-4 text-sm text-red-600">取数失败：{load.error}</Panel>;
  if (!load.snapshot) {
    return (
      <Panel className="p-10 text-center text-sm text-gray-500">
        还没有数据：定时同步（Actions 里的 <code>text-progress</code>）还没跑过，或中心库的 <code>progress</code> 表还没建。
      </Panel>
    );
  }
  return null;
}
