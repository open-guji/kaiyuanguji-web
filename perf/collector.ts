import type { BrowserContext, Page, CDPSession, Request } from 'playwright';

export interface RequestRecord {
    url: string;
    method: string;
    status: number;
    resourceType: string;
    encodedBytes: number;
    decodedBytes: number;
    durationMs: number;
    fromCache: boolean;
    failed: boolean;
    /** Distinguishes user-cancelled prefetches (e.g. ERR_ABORTED on navigation) from real failures. */
    aborted: boolean;
    failureReason?: string;
}

export interface PerceivedTiming {
    fcp: number | null;
    lcp: number | null;
    dcl: number | null;
    load: number | null;
}

export class NetworkCollector {
    private records: Map<string, RequestRecord> = new Map();
    private startedAt: number = 0;
    /** Playwright Request → key in `records` */
    private keyOf = (req: Request) => `${req.method()} ${req.url()} #${(req as any)._guid ?? Math.random()}`;
    private requestKey: WeakMap<Request, string> = new WeakMap();

    constructor(private context: BrowserContext) {}

    start() {
        this.startedAt = Date.now();
        this.context.on('request', (req) => {
            const key = this.keyOf(req);
            this.requestKey.set(req, key);
            this.records.set(key, {
                url: req.url(),
                method: req.method(),
                status: 0,
                resourceType: req.resourceType(),
                encodedBytes: 0,
                decodedBytes: 0,
                durationMs: 0,
                fromCache: false,
                failed: false,
                aborted: false,
            });
        });

        this.context.on('requestfinished', async (req) => {
            const key = this.requestKey.get(req);
            if (!key) return;
            const rec = this.records.get(key);
            if (!rec) return;

            const timing = req.timing();
            rec.durationMs = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : 0;

            try {
                const resp = await req.response();
                if (resp) {
                    rec.status = resp.status();
                    rec.fromCache = (resp as any).fromServiceWorker?.() ?? false;
                    const sizes = await req.sizes().catch(() => null);
                    if (sizes) {
                        rec.encodedBytes = (sizes.responseBodySize ?? 0) + (sizes.responseHeadersSize ?? 0);
                        rec.decodedBytes = sizes.responseBodySize ?? 0;
                    }
                    if (rec.encodedBytes === 0) {
                        const body = await resp.body().catch(() => null);
                        if (body) rec.decodedBytes = body.length;
                    }
                }
            } catch {
                // ignore
            }
        });

        this.context.on('requestfailed', (req) => {
            const key = this.requestKey.get(req);
            if (!key) return;
            const rec = this.records.get(key);
            if (!rec) return;
            rec.failed = true;
            rec.failureReason = req.failure()?.errorText ?? 'unknown';
            // ERR_ABORTED is what Chromium emits when the user/runtime cancels a
            // request — typically a Next.js prefetch that the page abandoned, or
            // a request still in flight when the test loop exits. These are not
            // real failures.
            if (rec.failureReason === 'net::ERR_ABORTED') {
                rec.aborted = true;
            }
        });
    }

    snapshot(): RequestRecord[] {
        return Array.from(this.records.values());
    }

    elapsed(): number {
        return Date.now() - this.startedAt;
    }
}

/**
 * Inject perf observers into the page so we can read FCP/LCP/DCL/load
 * after the scenario settles. Call BEFORE the first navigation.
 */
export async function installPerfHooks(page: Page) {
    await page.addInitScript(() => {
        (window as any).__perf = { fcp: null, lcp: null, dcl: null, load: null };

        try {
            const fcpObs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    if (e.name === 'first-contentful-paint') {
                        (window as any).__perf.fcp = e.startTime;
                    }
                }
            });
            fcpObs.observe({ type: 'paint', buffered: true });
        } catch {}

        try {
            const lcpObs = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const last = entries[entries.length - 1];
                if (last) (window as any).__perf.lcp = last.startTime;
            });
            lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}

        const onDcl = () => {
            (window as any).__perf.dcl = performance.now();
        };
        const onLoad = () => {
            (window as any).__perf.load = performance.now();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDcl);
        } else {
            onDcl();
        }
        if (document.readyState !== 'complete') {
            window.addEventListener('load', onLoad);
        } else {
            onLoad();
        }
    });
}

/** Wait until window.__perf.lcp is non-null, polling every 100ms. */
export async function waitForLcp(page: Page, timeoutMs = 60000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const lcp = await page.evaluate(() => {
            const p = (window as any).__perf;
            return typeof p?.lcp === 'number' ? p.lcp : null;
        }).catch(() => null);
        if (lcp !== null) return lcp;
        await page.waitForTimeout(100);
    }
    return null;
}

export async function readPerceivedTiming(page: Page): Promise<PerceivedTiming> {
    const result = await page.evaluate(() => {
        const p = (window as any).__perf || {};
        return {
            fcp: typeof p.fcp === 'number' ? p.fcp : null,
            lcp: typeof p.lcp === 'number' ? p.lcp : null,
            dcl: typeof p.dcl === 'number' ? p.dcl : null,
            load: typeof p.load === 'number' ? p.load : null,
        };
    }).catch(() => ({ fcp: null, lcp: null, dcl: null, load: null }));
    return result;
}

/**
 * Apply network throttling via CDP. Playwright doesn't expose this directly
 * for chromium but the underlying CDP session does.
 */
export async function applyThrottling(
    cdp: CDPSession,
    downloadBps: number,
    uploadBps: number,
    latencyMs: number,
) {
    const offline = false;
    const downloadThroughput = downloadBps < 0 ? -1 : downloadBps;
    const uploadThroughput = uploadBps < 0 ? -1 : uploadBps;
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
        offline,
        latency: latencyMs,
        downloadThroughput,
        uploadThroughput,
    });
}

/** Disable any prior throttling. */
export async function clearThrottling(cdp: CDPSession) {
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
    });
}
