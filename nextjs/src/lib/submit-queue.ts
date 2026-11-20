/**
 * 审阅页的后台提交队列（乐观提交用）。
 *
 * - 同一个 key（一格）的提交严格按点击顺序一个接一个发：服务端同格同人后写覆盖先写，不能乱序。
 * - 同一格还没开始发的旧提交，被后来的新提交顶掉（直接跳过，不白发一次）。
 * - 全局最多同时发 `concurrency` 个，别一口气把限速打满。
 * - task 返回错误文案（null＝成功）；抛出也算失败。
 */
export interface QueueResult {
    /** null＝成功；否则错误文案 */
    err: string | null;
    /** 这是该格最新的一次提交（后面没有更新的了）：只有它的结果才该决定界面状态 */
    latest: boolean;
    /** 被后来的提交顶掉、根本没发 */
    skipped: boolean;
}

export class SubmitQueue {
    private seqOf = new Map<string, number>();
    private tail = new Map<string, Promise<unknown>>();
    private active = 0;
    private waiting: Array<() => void> = [];
    private count = 0;

    constructor(private readonly concurrency = 3, private readonly onChange?: (pending: number) => void) {}

    /** 还没发完的提交数（排队＋正在发） */
    get pending(): number { return this.count; }

    /** 这一格还有没发完的提交 */
    has(key: string): boolean { return this.seqOf.has(key); }

    private bump(d: number) {
        this.count += d;
        this.onChange?.(this.count);
    }

    private acquire(): Promise<void> {
        if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
        return new Promise(resolve => this.waiting.push(() => { this.active++; resolve(); }));
    }

    private release() {
        this.active--;
        this.waiting.shift()?.();
    }

    enqueue(key: string, task: () => Promise<string | null>): Promise<QueueResult> {
        const seq = (this.seqOf.get(key) ?? 0) + 1;
        this.seqOf.set(key, seq);
        this.bump(1);
        const prev = this.tail.get(key) ?? Promise.resolve();
        const run = prev.then(async (): Promise<QueueResult> => {
            if (this.seqOf.get(key) !== seq) return { err: null, latest: false, skipped: true };
            await this.acquire();
            let err: string | null;
            try { err = await task(); } catch { err = '提交失败，请稍后再试'; } finally { this.release(); }
            return { err, latest: this.seqOf.get(key) === seq, skipped: false };
        });
        const settled = run.finally(() => {
            if (this.seqOf.get(key) === seq) { this.seqOf.delete(key); this.tail.delete(key); }
            this.bump(-1);
        });
        this.tail.set(key, settled.catch(() => undefined));
        return settled;
    }
}
