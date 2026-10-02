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
