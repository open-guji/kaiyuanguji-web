/**
 * 阅读页首次渲染的分段计时（overview#322 方案 D）：各跳取数耗时＋本实例是第几个请求，
 * 用来定冷启动慢在哪一步（h1 条目链、manifest／目录校验、跳转判定、首章正文），再决定方案 B 做哪几条。
 *
 * 只记录，不改行为。输出格式照 Server-Timing（`名;dur=毫秒, …`），写在两处：
 *   - 页面 HTML 里一个不渲染的 <script type="application/json" id="kyg-render-timing">：
 *     App Router 的页面设不了响应头，退而写进 HTML。页面是 ISR，缓存住的 HTML 带的就是「生成它的那次渲染」的计时，
 *     正好是冷启动要看的那次；之后命中缓存的访问看到的仍是那一次的数。
 *   - 函数日志一行 `[reader-timing] …`（控制台看得到）。
 *
 * inst：本进程（云函数实例）启动以来第几个阅读页请求、已运行多久——req=1 即冷实例上的第一个。
 */
let served = 0;
const bootAt = Date.now();

export interface RenderTiming {
    /** 本进程第几个阅读页请求（从 1 起） */
    reqNo: number;
    /** 本进程已运行毫秒数（请求开始时） */
    uptimeMs: number;
    /** 请求开始时刻（Date.now） */
    startedAt: number;
    /** 各段耗时，按完成先后 */
    marks: [string, number][];
}

export function startRenderTiming(now: number = Date.now()): RenderTiming {
    served += 1;
    return { reqNo: served, uptimeMs: now - bootAt, startedAt: now, marks: [] };
}

/** 计一段耗时；p 抛错（含 Next 的 redirect）也照记 */
export async function timed<T>(t: RenderTiming, name: string, p: Promise<T>): Promise<T> {
    const s = Date.now();
    try {
        return await p;
    } finally {
        t.marks.push([name, Date.now() - s]);
    }
}

/** Server-Timing 语法：`item;dur=812, check;dur=640, …, total;dur=1530, inst;desc="req=1 up=3s"` */
export function serverTimingValue(t: RenderTiming, now: number = Date.now()): string {
    const parts = t.marks.map(([n, d]) => `${n};dur=${d}`);
    parts.push(`total;dur=${now - t.startedAt}`);
    parts.push(`inst;desc="req=${t.reqNo} up=${Math.round(t.uptimeMs / 1000)}s"`);
    return parts.join(', ');
}

/**
 * 一次 current/ 取数在计时里的名字（overview#345 PR①：看冷实例上每一跳各花多久）：
 * `…/manifest.json`→`h:manifest`、`…/index.json`→`h:index`、章 `…/NNN.json`→`h:chapter-json`、`…/NNN.txt`→`h:chapter-txt`，其他→`h:other`。
 * 只用于命名，不参与任何取数判断。
 */
export function hopName(relPath: string): string {
    const base = relPath.split('?')[0].split('/').pop() ?? '';
    if (base === 'read-seed.json') return 'h:seed';
    if (base === 'manifest.json') return 'h:manifest';
    if (base === 'index.json') return 'h:index';
    if (base.endsWith('.json')) return 'h:chapter-json';
    if (base.endsWith('.txt')) return 'h:chapter-txt';
    return 'h:other';
}

/** 给 current/ 取数函数套一层计时：结果与抛错原样透传，只多记一段 `h:…`（并行的几跳耗时会重叠，各记各的）。类型原样保留（含泛型）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withHopTiming<F extends (relPath: string, ...rest: any[]) => Promise<any>>(t: RenderTiming, get: F): F {
    return ((relPath: string, ...rest: unknown[]) => timed(t, hopName(relPath), get(relPath, ...rest))) as F;
}
