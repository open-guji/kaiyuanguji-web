/**
 * 失败诊断（overview#470／#475）：阅读页旧入口用例在 CI 里「URL 对了、服务端 title 是卷四、水合后页面却变回卷一」，
 * 只有最终截图，看不出是哪一步、什么时候变的，本机又复现不了。这里在用例里挂上监听，**只在失败时**把下面几样附到报告里：
 *
 *   · 地址时间线：主框架每次导航（含 pushState／replaceState 这类同文档跳转）的地址与相对时间；
 *   · 标题／标题级元素时间线：页面里注入的观察者记录 document.title、<h1>、所选版本、当前章的变化——
 *     直接看到「什么时候从卷四变成卷一」；
 *   · 服务端 title：首个文档响应的 <title>（水合之前的样子）、响应头里的缓存信息（age／cache-control／x-cache 等）；
 *   · 请求时间线：页面发出的请求（文档、数据、接口；不含静态资源），状态码、耗时、缓存相关响应头；
 *   · 控制台的 warning／error 与页面错误；
 *   · 失败那一刻的 location、标题、<h1>、版本下拉的当前值。
 *
 * 用法（只在失败时附，通过的用例几乎无开销——只有监听和一个轻量的观察者）：
 *     const diag = startDiagnostics(page);
 *     try { ...用例... } catch (e) { await diag.attach(testInfo); throw e; }
 *
 * 附到报告的是两个文件：diagnostics.txt（人看）和 diagnostics.json（原始）。
 */
import type { Page, Request, Response, TestInfo } from '@playwright/test';

export type DiagEvent = { t: number; kind: string; detail: string };

export interface Diagnostics {
    /** 失败时把诊断附到报告；不会抛错（诊断本身出问题只记一行） */
    attach(testInfo: TestInfo): Promise<void>;
    /** 生成文本（也给自测用） */
    render(): Promise<string>;
}

/** 响应头里与缓存有关的几个，诊断时看「是不是 CDN 吐出来的旧页」 */
const CACHE_HEADERS = ['age', 'cache-control', 'eo-cdn-cache-control', 'x-cache', 'x-nws-log-uuid', 'server-timing', 'etag', 'last-modified', 'date'];

/** 静态资源不进请求时间线 */
const STATIC_RE = /\.(?:js|mjs|css|woff2?|ttf|png|jpe?g|gif|svg|ico|webp|avif|map)(?:\?|$)|\/_next\/static\//;

function pick(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of CACHE_HEADERS) if (headers[k] !== undefined) out[k] = headers[k];
    return out;
}

function titleOf(html: string): string {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1].replace(/\s+/g, ' ').trim() : '(无 title)';
}

/** 注入页面的观察者：记录 title／h1／所选版本／当前章的变化。字符串形式，避免被打包器改写 */
const OBSERVER_SCRIPT = `(() => {
  if (window.__kygDiag) return;
  const t0 = performance.now();
  const log = (window.__kygDiag = []);
  let last = '';
  const snap = () => {
    try {
      const h1 = Array.from(document.querySelectorAll('main h1')).map((e) => (e.textContent || '').trim()).join(' | ');
      const ver = document.querySelector('main select, main [role="combobox"]');
      const verText = ver ? ((ver.selectedOptions && ver.selectedOptions[0] && ver.selectedOptions[0].textContent) || ver.value || '') : '';
      const cur = document.querySelector('[data-rd-toc-key][aria-current], [data-rd-toc-key][data-active="true"], [data-rd-toc-key][aria-selected="true"]');
      const curKey = cur ? cur.getAttribute('data-rd-toc-key') : '';
      const s = [location.pathname, document.title, h1, verText, curKey].join('\\u0001');
      if (s === last) return;
      last = s;
      log.push({ t: Math.round(performance.now() - t0), path: location.pathname, title: document.title, h1, version: verText, tocCurrent: curKey || '' });
      if (log.length > 400) log.shift();
    } catch (e) { /* 观察者不能影响页面 */ }
  };
  const start = () => {
    snap();
    new MutationObserver(snap).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-current', 'aria-selected', 'data-active'] });
    setInterval(snap, 250);
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

export function startDiagnostics(page: Page): Diagnostics {
    const t0 = Date.now();
    const rel = () => Date.now() - t0;
    const events: DiagEvent[] = [];
    const pending: Array<Promise<void>> = [];
    const serverTitles: Array<{ url: string; status: number; title: string; headers: Record<string, string> }> = [];
    const started = new Map<Request, number>();

    const safe = (fn: () => Promise<void>) => {
        pending.push(fn().catch((e) => void events.push({ t: rel(), kind: 'diag-error', detail: String(e?.message ?? e).slice(0, 200) })));
    };

    // 观察者：每次新文档都注入。注入失败（页面已关）不影响用例
    page.addInitScript(OBSERVER_SCRIPT).catch(() => undefined);

    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) events.push({ t: rel(), kind: 'navigated', detail: frame.url() });
    });
    page.on('console', (m) => {
        const type = m.type();
        if (type === 'warning' || type === 'error') events.push({ t: rel(), kind: `console.${type}`, detail: m.text().slice(0, 300) });
    });
    page.on('pageerror', (e) => events.push({ t: rel(), kind: 'pageerror', detail: String(e?.message ?? e).slice(0, 300) }));
    page.on('request', (r) => started.set(r, rel()));
    page.on('requestfailed', (r) => {
        if (STATIC_RE.test(r.url())) return;
        events.push({ t: rel(), kind: 'request-failed', detail: `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? '?'}` });
    });
    page.on('response', (res: Response) => {
        const req = res.request();
        const url = res.url();
        if (STATIC_RE.test(url)) return;
        const begin = started.get(req) ?? rel();
        safe(async () => {
            const headers = pick(await res.allHeaders());
            const isDoc = req.resourceType() === 'document' && req.frame() === page.mainFrame();
            if (isDoc) {
                // 服务端直出的 title（水合之前）。被重定向走的响应没有 body，读不到就记空
                let title = '(读不到 body)';
                try { title = titleOf(await res.text()); } catch { /* 重定向响应等 */ }
                serverTitles.push({ url, status: res.status(), title, headers });
            }
            events.push({
                t: begin,
                kind: isDoc ? 'document' : 'request',
                detail: `${req.method()} ${res.status()} ${url.slice(0, 220)} (${rel() - begin}ms)${Object.keys(headers).length ? ' ' + JSON.stringify(headers) : ''}`,
            });
        });
    });

    async function collect() {
        await Promise.allSettled(pending);
        let observed: unknown[] = [];
        let now: Record<string, unknown> = {};
        try {
            observed = await page.evaluate(() => (window as unknown as { __kygDiag?: unknown[] }).__kygDiag ?? []);
            now = await page.evaluate(() => ({
                href: location.href,
                title: document.title,
                h1: Array.from(document.querySelectorAll('main h1')).map((e) => (e.textContent || '').trim()),
                version: (() => {
                    const s = document.querySelector('main select') as HTMLSelectElement | null;
                    return s?.selectedOptions?.[0]?.textContent ?? '';
                })(),
                visibility: document.visibilityState,
                readyState: document.readyState,
            }));
        } catch (e) {
            now = { error: String((e as Error)?.message ?? e) };
        }
        // 事件太多（页面一直在预取）时只留头尾，别把附件撑到几 MB
        const sorted = [...events].sort((a, b) => a.t - b.t);
        const MAX = 300;
        const trimmed = sorted.length <= MAX ? sorted : [...sorted.slice(0, 150), { t: sorted[150].t, kind: 'trimmed', detail: `（中间省略 ${sorted.length - MAX} 条）` }, ...sorted.slice(-150)];
        return { events: trimmed, serverTitles, observed, now };
    }

    async function render() {
        const d = await collect();
        const lines: string[] = [];
        lines.push('## 失败时页面');
        lines.push(JSON.stringify(d.now, null, 2));
        lines.push('', '## 服务端直出的 title（水合之前，首个文档响应）');
        for (const s of d.serverTitles) lines.push(`- ${s.status} ${s.url}\n  title: ${s.title}\n  headers: ${JSON.stringify(s.headers)}`);
        if (!d.serverTitles.length) lines.push('- （没有捕获到主框架的文档响应）');
        lines.push('', '## 页面内变化时间线（title／h1／版本／当前章；t＝页面加载后毫秒）');
        for (const o of d.observed as Array<Record<string, unknown>>) {
            lines.push(`- ${String(o.t).padStart(6)}ms  ${o.path}  title=「${o.title}」 h1=「${o.h1}」 版本=「${o.version}」 当前章=${o.tocCurrent || '-'}`);
        }
        if (!d.observed.length) lines.push('- （没有记录——页面可能没加载出来）');
        lines.push('', '## 事件时间线（导航、请求、控制台；t＝用例内毫秒）');
        for (const e of d.events) lines.push(`- ${String(e.t).padStart(6)}ms  [${e.kind}] ${e.detail}`);
        return lines.join('\n');
    }

    return {
        render,
        async attach(testInfo) {
            try {
                const d = await collect();
                await testInfo.attach('diagnostics.txt', { body: await render(), contentType: 'text/plain; charset=utf-8' });
                await testInfo.attach('diagnostics.json', { body: JSON.stringify(d, null, 2), contentType: 'application/json' });
            } catch (e) {
                console.warn(`[diagnostics] 附诊断失败：${(e as Error)?.message ?? e}`);
            }
        },
    };
}
