// 后台「文本整理」栏目：快照的类型与纯函数（快照由 ops/text-progress/sync.py export 生成，形状见 docs/text-progress.md）

export interface FieldMeta { by?: string; at?: string }

export interface VolumeRow {
  book_id: string;
  vol: string;
  book_title?: string | null;
  vol_title?: string | null;
  vol_order?: number | null;
  ws?: string | null;
  cv_book?: string | null;
  stage?: Stage | null;
  text_version?: string | null;
  punct_version?: string | null;
  entity_version?: string | null;
  proofing?: boolean | null;
  frozen_version?: string | null;
  cv_version?: string | null;
  corpus?: string | null;
  glyph_pin?: string | null;
  cells_total?: number | null;
  pending_review?: number | null;
  human_judged?: number | null;
  pending_rev?: string | null;
  pending_at?: string | null;
  punct_status?: string | null;
  note?: string | null;
  updated_at?: string | null;
  extra?: Record<string, unknown>;
  field_meta?: Record<string, FieldMeta>;
}

export interface Section { section: string; title: string; owner?: string | null; description?: string | null; sort?: number }

export interface Metric {
  book_id: string;
  vol: string;
  section: string;
  key: string;
  label: string;
  value?: number | null;
  value_text?: string | null;
  unit?: string | null;
  detail?: unknown;
  sort?: number;
  writer?: string;
  at?: string | null;
}

export interface CollectorRun { at?: string; finished_at?: string; volumes?: number; problems?: string[]; source?: string }

export interface Snapshot {
  schema: string;
  generated_at?: string;
  collector?: CollectorRun | null;
  volumes: VolumeRow[];
  sections: Section[];
  metrics: Metric[];
}

export type Stage = 'todo' | 'pipeline' | 'rough' | 'fine' | 'released';

export const STAGE_LABEL: Record<Stage, string> = {
  todo: '未开工',
  pipeline: '跑管线',
  rough: '粗校',
  fine: '精校',
  released: '已出 1.0',
};

/** 阶段的说明（鼠标悬停看），口径同 ai-team `team/整理/设计/文本整理三阶段流程.md` 第二节 */
export const STAGE_HINT: Record<Stage, string> = {
  todo: '还没开始整理',
  pipeline: 'CV 管线在跑',
  rough: '平台粗校中，还没出 0.1.0',
  fine: '粗校已出（文本 0.x），精校进行中：逐格过待审',
  released: '精校完成（文本 1.0.0 及以上），之后靠网站反馈持续修订',
};

export const STAGE_ORDER: Stage[] = ['todo', 'pipeline', 'rough', 'fine', 'released'];

/** 文本版本的主版本号；不是 x.y.z 形状返回 null */
export function majorOf(v: string | null | undefined): number | null {
  const m = /^(\d+)\.\d+\.\d+/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 这一册在哪个阶段：领域写了 stage 就用它；没写就按文本版本推断（推断的 derived=true，页面上标出来）。
 * 0.x → 精校（0.1.0＝粗校完成可上网站，之后每合一批人裁升 minor）；≥1 → 已出 1.0；没有文本但有 cv 册 → 粗校；都没有 → 未开工。
 */
export function stageOf(v: VolumeRow): { stage: Stage; derived: boolean } {
  if (v.stage && v.stage in STAGE_LABEL) return { stage: v.stage, derived: false };
  const major = majorOf(v.text_version);
  if (major === null) return { stage: v.cv_book ? 'rough' : 'todo', derived: true };
  return { stage: major >= 1 ? 'released' : 'fine', derived: true };
}

export interface BookGroup {
  book_id: string;
  title: string;
  volumes: VolumeRow[];
  pending: number;
  stages: Partial<Record<Stage, number>>;
}

/** 按套书分组；组内按 vol_order、vol 排；册多的套书排前面（正在整理的大部头先看），同样多按书名 */
export function groupByBook(volumes: VolumeRow[]): BookGroup[] {
  const map = new Map<string, BookGroup>();
  for (const v of volumes) {
    let g = map.get(v.book_id);
    if (!g) {
      g = { book_id: v.book_id, title: v.book_title || v.book_id, volumes: [], pending: 0, stages: {} };
      map.set(v.book_id, g);
    }
    if (v.book_title && g.title === g.book_id) g.title = v.book_title;
    g.volumes.push(v);
    g.pending += typeof v.pending_review === 'number' ? v.pending_review : 0;
    const s = stageOf(v).stage;
    g.stages[s] = (g.stages[s] ?? 0) + 1;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.volumes.sort((a, b) => {
      const oa = a.vol_order ?? Number.MAX_SAFE_INTEGER;
      const ob = b.vol_order ?? Number.MAX_SAFE_INTEGER;
      return oa !== ob ? oa - ob : a.vol < b.vol ? -1 : a.vol > b.vol ? 1 : 0;
    });
  }
  return groups.sort((a, b) => b.volumes.length - a.volumes.length || a.title.localeCompare(b.title, 'zh') || (a.book_id < b.book_id ? -1 : 1));
}

const LA_TZ = 'America/Los_Angeles';

/** 时间一律按洛杉矶时间显示（项目规矩），形如 10-24 21:11 */
export function fmtLA(iso: string | null | undefined, withYear = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LA_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${withYear ? `${p.year}-` : ''}${p.month}-${p.day} ${hour}:${p.minute}`;
}

/** 距今多久：刚刚／N 分钟前／N 小时前／N 天前 */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 2) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 快照超过这么久没更新就在页面上提醒（定时任务每小时一次，GitHub 定时常晚几小时） */
export const STALE_HOURS = 6;

export function isStale(iso: string | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return true;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) || now - t > STALE_HOURS * 3600 * 1000;
}

export function fmtInt(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

/** 指标值：比率（unit=%）按小数存、显示成百分数；其余数字带单位；没有数字就显示 value_text */
export function fmtMetric(m: Pick<Metric, 'value' | 'value_text' | 'unit'>): string {
  if (typeof m.value === 'number' && Number.isFinite(m.value)) {
    if (m.unit === '%') return `${(m.value * 100).toFixed(m.value * 100 >= 10 ? 1 : 2)}%`;
    const s = Number.isInteger(m.value) ? m.value.toLocaleString('en-US') : String(Number(m.value.toFixed(4)));
    return m.unit ? `${s} ${m.unit}` : s;
  }
  return m.value_text || '—';
}

/** 指标的范围：全局／整套书／某册 */
export function scopeOf(m: Pick<Metric, 'book_id' | 'vol'>, titles: Map<string, string>): string {
  if (!m.book_id) return '全部';
  const t = titles.get(m.book_id) || m.book_id;
  return m.vol ? `${t} · ${m.vol}` : `${t}（整套）`;
}

/** 一行里各字段的写入方（去重，采集排最后），给「更新」列的悬停说明用 */
export function writersOf(v: VolumeRow): string[] {
  const set = new Set<string>();
  for (const m of Object.values(v.field_meta || {})) if (m && m.by) set.add(m.by);
  return [...set].sort((a, b) => (a === 'web-collector' ? 1 : b === 'web-collector' ? -1 : a < b ? -1 : 1));
}
