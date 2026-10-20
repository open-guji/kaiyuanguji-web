// 阅读页性能探针（docs/reader-performance.md）：三档 a=不节流 / b=慢4G+CPU4x / c=手机390宽+CPU6x
// 用法（在 perf/ 下）：node reader-probe.mjs <a|b|c> [第几次]；URL_=<地址> 换页面；EXTRA_ARGS="--disable-webgl" TAG=nowebgl 跑对照
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.env.URL_ || 'https://www.openguji.com/read/96mid1ogzk/002';
const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'out', 'reader');
fs.mkdirSync(OUT, { recursive: true });

const PROFILES = {
  a: { name: 'a-fast', label: '(a) 不节流 1440x900', viewport: { width: 1440, height: 900 }, cpu: 1, net: null },
  b: { name: 'b-slow4g-cpu4', label: '(b) 400KB/s+400ms RTT + CPU 4x, 1440x900', viewport: { width: 1440, height: 900 }, cpu: 4,
       net: { offline: false, latency: 400, downloadThroughput: 400 * 1024, uploadThroughput: 400 * 1024 } },
  c: { name: 'c-mobile-cpu6', label: '(c) 390x844 移动端 + CPU 6x（不限网速）', viewport: { width: 390, height: 844 }, cpu: 6, net: null, mobile: true },
};
const prof = PROFILES[process.argv[2] || 'a'];
const runIdx = process.argv[3] || '1';
if (process.env.TAG) prof.name += '-' + process.env.TAG;
if (!prof) throw new Error('profile a|b|c');

const INIT = () => {
  const pf = (window.__pf = { lt: [], loaf: [], ev: [], fi: null, lcp: null, lcpEl: null, fcp: null,
    charInserted: null, charPainted: null, charInView: null, warpAppeared: null, canvasAppeared: null, selRectAt: [], clickMarks: [] });
  const tryObs = (opts, cb) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe(opts); } catch (e) { pf['err_' + opts.type] = String(e); } };
  tryObs({ type: 'longtask', buffered: true }, (e) => pf.lt.push({ s: e.startTime, d: e.duration }));
  tryObs({ type: 'long-animation-frame', buffered: true }, (e) => pf.loaf.push({ s: e.startTime, d: e.duration, blk: e.blockingDuration, render: e.renderStart, styleLayout: e.styleAndLayoutStart,
    scripts: (e.scripts || []).slice(0, 3).map((s) => ({ inv: s.invoker, d: s.duration, src: (s.sourceURL || '').slice(-60), fn: s.sourceFunctionName, fsl: s.forcedStyleAndLayoutDuration })) }));
  tryObs({ type: 'paint', buffered: true }, (e) => { if (e.name === 'first-contentful-paint') pf.fcp = e.startTime; });
  tryObs({ type: 'largest-contentful-paint', buffered: true }, (e) => {
    pf.lcp = e.startTime; const el = e.element;
    pf.lcpEl = { tag: el && el.tagName, cls: el && typeof el.className === 'string' ? el.className.slice(0, 80) : (el && el.className && el.className.baseVal), url: e.url, size: e.size, text: el && (el.textContent || '').slice(0, 40) };
  });
  tryObs({ type: 'event', durationThreshold: 16, buffered: true }, (e) => pf.ev.push({ name: e.name, s: e.startTime, d: e.duration, ps: e.processingStart, pe: e.processingEnd, iid: e.interactionId,
    tgt: e.target ? e.target.tagName + '.' + String(e.target.className && e.target.className.baseVal !== undefined ? e.target.className.baseVal : e.target.className).slice(0, 40) : null }));
  tryObs({ type: 'first-input', buffered: true }, (e) => { pf.fi = { name: e.name, s: e.startTime, d: e.duration, ps: e.processingStart, pe: e.processingEnd }; });
  const mo = new MutationObserver(() => {
    if (pf.charInserted === null) {
      const c = document.querySelector('[data-char-id]');
      if (c) { pf.charInserted = performance.now(); requestAnimationFrame(() => setTimeout(() => { pf.charPainted = performance.now(); }, 0)); }
    }
    if (pf.warpAppeared === null && document.querySelector('[data-warp-page]')) pf.warpAppeared = performance.now();
    if (pf.canvasAppeared === null && document.querySelector('canvas')) pf.canvasAppeared = performance.now();
    if (pf.watchSel) {
      if (document.querySelector('svg rect[data-selected="true"]')) {
        const t = performance.now(); pf.watchSel = false;
        requestAnimationFrame(() => setTimeout(() => pf.selRectAt.push({ dom: t, painted: performance.now() }), 0));
      }
    }
    if (pf.charInserted !== null && pf.warpAppeared !== null && pf.canvasAppeared !== null && !pf.watchSel && pf.keepObs !== true) { /* keep observing for selection */ }
  });
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-selected'] });
  // 正文进入视口：首个字插入后用 IntersectionObserver（不强制布局）
  const startIO = () => {
    const els = [...document.querySelectorAll('[data-char-id]')].slice(0, 30);
    const io = new IntersectionObserver((ents) => { if (pf.charInView === null && ents.some((x) => x.isIntersecting)) { pf.charInView = performance.now(); io.disconnect(); } });
    els.forEach((e) => io.observe(e));
  };
  const waitChar = setInterval(() => { if (pf.charInserted !== null) { clearInterval(waitChar); startIO(); } }, 20);
  // 书影页码变化（滚动时用来对照长任务）
  pf.warpChanges = [];
  const mo2 = new MutationObserver((ms) => { for (const m of ms) if (m.attributeName === 'data-warp-page') pf.warpChanges.push({ t: performance.now(), v: m.target.getAttribute('data-warp-page') }); });
  mo2.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-warp-page'] });
  window.addEventListener('pointerdown', (e) => pf.clickMarks.push({ type: 'pointerdown', ts: e.timeStamp, now: performance.now() }), true);
};

function hostOf(u) { try { return new URL(u).host; } catch { return u.slice(0, 30); } }
function classify(r) {
  const u = r.url, mt = (r.mimeType || '').toLowerCase(), t = r.type;
  if (t === 'Document') return 'HTML';
  if (/[?&]_rsc=/.test(u) || mt.includes('x-component')) return 'RSC';
  if (t === 'Script' || mt.includes('javascript')) return 'JS';
  if (t === 'Stylesheet' || mt.includes('css')) return 'CSS';
  if (t === 'Font' || /\.(woff2?|ttf|otf)(\?|$)/.test(u)) return '字体';
  if (t === 'Image' || mt.startsWith('image/')) return '图片';
  if (mt.includes('json') || /\.json(\?|$)/.test(u)) return 'JSON';
  return t || 'other';
}
function imgDims(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { fmt: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { fmt: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
      const k = buf.slice(12, 16).toString();
      if (k === 'VP8 ') return { fmt: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { fmt: 'webp', w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      if (k === 'VP8X') return { fmt: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (buf.slice(4, 12).toString().includes('ftypavif')) return { fmt: 'avif' };
  } catch {}
  return null;
}

let curBrowser = null;
async function runOnce() {
  const browser = curBrowser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true,
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '<-loopback>,localhost,127.0.0.1' } } : {}),
    args: [...(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : []), '--disable-background-networking', '--disable-component-update', '--no-default-browser-check', '--enable-unsafe-swiftshader'],
  });
  const ctxOpts = { viewport: prof.viewport };
  if (prof.mobile) Object.assign(ctxOpts, { isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' });
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  await page.addInitScript(INIT);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable', { maxTotalBufferSize: 200e6, maxResourceBufferSize: 50e6 });
  await cdp.send('Performance.enable');
  if (prof.net) await cdp.send('Network.emulateNetworkConditions', prof.net);
  if (prof.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });

  const reqs = new Map();
  let phase = 'load';
  let t0 = null; // monotonic seconds of document request
  cdp.on('Network.requestWillBeSent', (e) => {
    if (t0 === null && e.type === 'Document') t0 = e.timestamp;
    const prev = reqs.get(e.requestId);
    if (prev && e.redirectResponse) prev.redirects = (prev.redirects || 0) + 1;
    reqs.set(e.requestId, Object.assign(prev || {}, { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, phase,
      start: e.timestamp, priority: e.request.initialPriority, initiator: e.initiator && e.initiator.type, decoded: 0 }));
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId); if (!r) return;
    const h = {}; for (const [k, v] of Object.entries(e.response.headers || {})) h[k.toLowerCase()] = v;
    Object.assign(r, { status: e.response.status, mimeType: e.response.mimeType, protocol: e.response.protocol,
      fromDiskCache: e.response.fromDiskCache, fromSW: e.response.fromServiceWorker,
      headers: { 'content-encoding': h['content-encoding'], 'content-length': h['content-length'], 'cache-control': h['cache-control'], etag: h['etag'], 'last-modified': h['last-modified'], 'content-type': h['content-type'], age: h['age'], 'eo-cache-status': h['eo-cache-status'], 'x-cache': h['x-cache'] || h['x-cache-lookup'], 'access-control-allow-origin': h['access-control-allow-origin'], vary: h['vary'] },
      ttfbMs: e.response.timing ? Math.round(e.response.timing.receiveHeadersEnd) : null,
      timingRaw: e.response.timing ? { dns: e.response.timing.dnsEnd - e.response.timing.dnsStart, connect: e.response.timing.connectEnd - e.response.timing.connectStart, ssl: e.response.timing.sslEnd - e.response.timing.sslStart, send: e.response.timing.sendStart, recvHeaders: e.response.timing.receiveHeadersEnd } : null });
  });
  cdp.on('Network.dataReceived', (e) => { const r = reqs.get(e.requestId); if (r) r.decoded += e.dataLength; });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.encoded = e.encodedDataLength; r.done = true; } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.failed = e.errorText; r.canceled = e.canceled; } });

  const wallStart = Date.now();
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await page.waitForSelector('[data-char-id]', { state: 'attached', timeout: 240000 });
  // 等网络静止：连续 4s 无 in-flight 请求（最长 120s）
  const quietDeadline = Date.now() + 120000;
  let quietSince = Date.now();
  while (Date.now() < quietDeadline) {
    const inflight = [...reqs.values()].filter((r) => !r.done && !r.failed).length;
    if (inflight > 0) quietSince = Date.now();
    if (Date.now() - quietSince > 4000) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1000);
  const loadWall = Date.now() - wallStart;

  // ---- 计时 ----
  const timing = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const pf = window.__pf;
    return { ttfb: n.responseStart, responseEnd: n.responseEnd, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, domInteractive: n.domInteractive,
      transferSize: n.transferSize, encodedBodySize: n.encodedBodySize, decodedBodySize: n.decodedBodySize, nextHop: n.nextHopProtocol,
      fcp: pf.fcp, lcp: pf.lcp, lcpEl: pf.lcpEl, charInserted: pf.charInserted, charPainted: pf.charPainted, charInView: pf.charInView,
      warpAppeared: pf.warpAppeared, canvasAppeared: pf.canvasAppeared, errs: Object.keys(pf).filter((k) => k.startsWith('err_')).map((k) => pf[k]),
      ltLoad: pf.lt.slice(), loafLoad: pf.loaf.slice(), now: performance.now() };
  });

  // ---- 堆 ----
  const heap = async (label) => {
    const h = await cdp.send('Runtime.getHeapUsage');
    const dc = await cdp.send('Memory.getDOMCounters').catch(() => null);
    const pm = await page.evaluate(() => performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null);
    return { label, usedSize: h.usedSize, totalSize: h.totalSize, domCounters: dc, perfMemory: pm };
  };
  const heaps = [await heap('加载后')];
  await cdp.send('HeapProfiler.collectGarbage');
  heaps.push(await heap('加载后+强制GC'));

  // ---- DOM 规模 ----
  const dom = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    let maxDepth = 0, deepest = null;
    const depth = (el) => { let d = 0; while (el) { d++; el = el.parentElement; } return d; };
    for (const el of all) { if (el.children.length === 0) { const d = depth(el); if (d > maxDepth) { maxDepth = d; deepest = el; } } }
    const pane = document.querySelector('.guji-text-pane-content');
    const chars = document.querySelectorAll('span[data-char-id]');
    const charSample = chars[0] ? chars[0].outerHTML.slice(0, 300) : null;
    let multiChar = 0; for (const c of chars) if ((c.textContent || '').length > 1) multiChar++;
    const charDescendants = chars[0] ? chars[0].querySelectorAll('*').length : null;
    const tagCount = {}; if (pane) for (const el of pane.querySelectorAll('*')) tagCount[el.tagName] = (tagCount[el.tagName] || 0) + 1;
    const svgRects = document.querySelectorAll('svg rect').length;
    const sections = document.querySelectorAll('[data-page-section]').length;
    const se = document.scrollingElement;
    const path = []; let e = deepest; while (e && path.length < 40) { path.unshift(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '')); e = e.parentElement; }
    return { totalElements: all.length, paneElements: pane ? pane.querySelectorAll('*').length : null, paneTextLen: pane ? (pane.textContent || '').length : null,
      paneTagCount: tagCount, charSpans: chars.length, charSpansMultiChar: multiChar, charSpanDescendants: charDescendants, charSample,
      punctSpans: document.querySelectorAll('[data-punct-id]').length, svgRects, pageSections: sections, maxDepth, deepestPath: path.join(' > '),
      canvases: [...document.querySelectorAll('canvas')].map((c) => ({ w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight })),
      imgs: [...document.images].map((i) => ({ src: i.currentSrc.slice(0, 120), nw: i.naturalWidth, nh: i.naturalHeight, loading: i.loading })),
      scrollH: se.scrollHeight, innerH: innerHeight, innerW: innerWidth, warpPage: document.querySelector('[data-warp-page]') && document.querySelector('[data-warp-page]').getAttribute('data-warp-page') };
  });

  // ---- 资源体 ----
  const bodies = {};
  for (const r of reqs.values()) {
    const cls = classify(r);
    if (!r.done || !['HTML', 'JS', 'JSON', '图片', 'RSC', 'CSS'].includes(cls)) continue;
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: r.id });
      const buf = Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8');
      r.bodyLen = buf.length;
      if (cls === '图片') r.dims = imgDims(buf);
      else {
        const s = buf.toString('utf8');
        const cjk = (s.match(/[㐀-鿿豈-﫿]|[\ud840-\ud87f][\udc00-\udfff]/g) || []).length;
        r.cjkChars = cjk;
        if (cls === 'HTML') {
          const pushes = [...s.matchAll(/<script[^>]*>(self\.__next_f\.push\([\s\S]*?\))<\/script>/g)].map((m) => m[1]);
          r.rsc = { pushCount: pushes.length, pushBytes: pushes.reduce((a, p) => a + Buffer.byteLength(p), 0), largestPush: Math.max(0, ...pushes.map((p) => Buffer.byteLength(p))),
            htmlBytes: buf.length, inlineScriptBytes: [...s.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].reduce((a, m) => a + Buffer.byteLength(m[1]), 0) };
          fs.writeFileSync(path.join(OUT, `${prof.name}-doc.html`), buf);
        }
        if (cls === 'JS') {
          const kw = {}; for (const k of ['variant', 'VARIANT', '異體', '异体', 'char.json', 'cord', 'punct', 'entity', 'norm', 'webgl', 'pdfjs', 'mermaid', 'katex', 'highlight', 'recharts', 'lodash']) { const m = s.split(k).length - 1; if (m) kw[k] = m; }
          r.kw = kw;
          const name = r.url.split('/').pop().split('?')[0];
          if (runIdx === '1' && prof.name === 'a-fast') { fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true }); fs.writeFileSync(path.join(OUT, 'chunks', name), buf); }
        }
        if (cls === 'JSON') {
          try { const j = JSON.parse(s); r.jsonShape = Array.isArray(j) ? `array[${j.length}]` : 'object{' + Object.keys(j).slice(0, 12).map((k) => k + ':' + (Array.isArray(j[k]) ? `[${j[k].length}]` : typeof j[k])).join(',') + '}'; } catch { r.jsonShape = 'parse-fail'; }
        }
      }
    } catch (err) { r.bodyErr = String(err.message).slice(0, 80); }
  }

  // ---- 滚动 ----
  const scrollInfo = await page.evaluate(() => {
    const se = document.scrollingElement;
    const winScrollable = se.scrollHeight > innerHeight * 1.5;
    let target = null;
    if (!winScrollable) {
      const cands = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 100; });
      cands.sort((a, b) => b.scrollHeight - a.scrollHeight);
      if (cands[0]) { cands[0].setAttribute('data-perf-scroller', '1'); target = String(cands[0].className).slice(0, 80); }
    }
    return { winScrollable, target, scrollH: se.scrollHeight, innerH: innerHeight, htmlScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior, bodyScrollBehavior: getComputedStyle(document.body).scrollBehavior, startScrollY: scrollY };
  });
  phase = 'scroll';
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', 'blink.user_timing', 'toplevel', 'disabled-by-default-devtools.timeline.frame'] });
  const scroll = await page.evaluate(async () => {
    const pf = window.__pf;
    const el = document.querySelector('[data-perf-scroller]');
    const vh = el ? el.clientHeight : innerHeight;
    const screens = 8, step = 40; // 每帧 40px ≈ 2400px/s @60fps
    const total = screens * vh;
    const startY = el ? el.scrollTop : scrollY;
    const ltBefore = pf.lt.length, loafBefore = pf.loaf.length;
    const t0 = performance.now();
    performance.mark('scroll-start');
    const frames = [];
    await new Promise((res) => {
      let moved = 0, last = null;
      const f = (ts) => {
        if (last !== null) frames.push(ts - last);
        last = ts;
        if (moved >= total) return res();
        if (el) el.scrollBy({ top: step, behavior: 'instant' }); else window.scrollBy({ top: step, behavior: 'instant' });
        moved += step;
        requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    performance.mark('scroll-end');
    const t1 = performance.now();
    const endY = el ? el.scrollTop : scrollY;
    await new Promise((r) => setTimeout(r, 1500));
    const lt = pf.lt.slice(ltBefore).filter((x) => x.s >= t0 - 5 && x.s <= t1 + 1500);
    const loaf = pf.loaf.slice(loafBefore).filter((x) => x.s >= t0 - 5 && x.s <= t1 + 1500);
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const sorted = frames.slice().sort((a, b) => a - b);
    return { screens, stepPx: step, vh, scrolledPx: endY - startY, durationMs: t1 - t0, frames: frames.length, avgFrameMs: avg, avgFps: 1000 / avg,
      p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1],
      framesOver50: frames.filter((x) => x > 50).length, framesOver33: frames.filter((x) => x > 33.4).length, framesOver100: frames.filter((x) => x > 100).length,
      frameIntervals: frames.map((x) => Math.round(x * 10) / 10), longTasks: lt, loaf, t0, t1, warpChanges: pf.warpChanges.filter((w) => w.t >= t0 && w.t <= t1 + 1500) };
  });
  const traceBuf = await browser.stopTracing();
  fs.writeFileSync(path.join(OUT, `${prof.name}-r${runIdx}-scroll-trace.json`), traceBuf);
  const trace = analyzeTrace(JSON.parse(traceBuf.toString()));
  heaps.push(await heap('滚动后'));

  // ---- 交互：点字 ----
  phase = 'click';
  // 回到顶部再选可见字
  await page.evaluate(() => { const el = document.querySelector('[data-perf-scroller]'); if (el) el.scrollTop = 0; else window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.waitForTimeout(1500);
  const clicks = [];
  const targets = await page.evaluate(() => {
    const out = []; const els = document.querySelectorAll('span[data-char-id]');
    const vis = [];
    for (const e of els) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.top > 80 && r.bottom < innerHeight - 40 && r.left > 0 && r.right < innerWidth) vis.push({ id: e.getAttribute('data-char-id'), x: r.left + r.width / 2, y: r.top + r.height / 2 }); if (vis.length > 400) break; }
    for (const k of [0.1, 0.4, 0.7, 0.9, 0.55]) if (vis.length) out.push(vis[Math.floor(k * (vis.length - 1))]);
    return out;
  });
  for (const t of targets) {
    const before = await page.evaluate(() => { const pf = window.__pf; pf.watchSel = true; return { evLen: pf.ev.length, selLen: pf.selRectAt.length, cmLen: pf.clickMarks.length, now: performance.now() }; });
    if (prof.mobile) await page.touchscreen.tap(t.x, t.y); else await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(1800);
    const after = await page.evaluate((b) => {
      const pf = window.__pf;
      const cm = pf.clickMarks.slice(b.cmLen)[0];
      const sel = pf.selRectAt.slice(b.selLen)[0];
      return { events: pf.ev.slice(b.evLen), pointerdown: cm || null, selRect: sel || null, selRectExists: !!document.querySelector('svg rect[data-selected="true"]'),
        selectedSpan: !!document.querySelector('span[data-char-id].is-selected'), warpPage: document.querySelector('[data-warp-page]') && document.querySelector('[data-warp-page]').getAttribute('data-warp-page'), clickedAt: b.now };
    }, before);
    const maxEv = after.events.reduce((m, e) => Math.max(m, e.d), 0);
    clicks.push({ target: t, ...after, maxEventDuration: maxEv,
      pointerdownToHighlightDom: after.pointerdown && after.selRect ? after.selRect.dom - after.pointerdown.ts : null,
      pointerdownToHighlightPaint: after.pointerdown && after.selRect ? after.selRect.painted - after.pointerdown.ts : null });
  }
  heaps.push(await heap('点击后'));
  const final = await page.evaluate(() => ({ fi: window.__pf.fi, allLt: window.__pf.lt, allEvCount: window.__pf.ev.length }));
  await page.screenshot({ path: path.join(OUT, `${prof.name}-r${runIdx}.png`) });
  const perfMetrics = (await cdp.send('Performance.getMetrics')).metrics.reduce((o, m) => (o[m.name] = m.value, o), {});
  await browser.close();

  // ---- 汇总请求 ----
  const list = [...reqs.values()].map((r) => ({
    url: r.url, short: r.url.replace(/^https?:\/\//, '').slice(0, 110), host: hostOf(r.url), type: r.type, cls: classify(r), phase: r.phase, status: r.status, mime: r.mimeType,
    protocol: r.protocol, priority: r.priority, encoded: r.encoded ?? null, decoded: r.decoded, bodyLen: r.bodyLen ?? null,
    startMs: t0 !== null ? Math.round((r.start - t0) * 1000) : null, endMs: r.end && t0 !== null ? Math.round((r.end - t0) * 1000) : null,
    ttfbMs: r.ttfbMs, headers: r.headers, failed: r.failed || null, dims: r.dims, rsc: r.rsc, kw: r.kw, cjkChars: r.cjkChars, jsonShape: r.jsonShape, fromDiskCache: r.fromDiskCache,
  })).sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const agg = {};
  for (const r of list) {
    const k1 = `${r.phase}|${r.cls}`; const k2 = `${r.phase}|${r.host}`;
    for (const k of [k1, k2]) { agg[k] = agg[k] || { n: 0, encoded: 0, decoded: 0 }; agg[k].n++; agg[k].encoded += r.encoded || 0; agg[k].decoded += r.decoded || 0; }
  }
  const lt = timing.ltLoad;
  const fcp = timing.fcp ?? 0;
  const tbt = lt.filter((x) => x.s >= fcp).reduce((a, x) => a + Math.max(0, x.d - 50), 0);
  const result = {
    profile: prof, run: runIdx, url: URL_, measuredAt: new Date().toISOString(), loadWallMs: loadWall,
    timing: { ...timing, ltLoad: undefined, loafLoad: undefined },
    longTasksLoad: { count: lt.length, totalMs: lt.reduce((a, x) => a + x.d, 0), tbtAfterFcp: tbt, top: lt.slice().sort((a, b) => b.d - a.d).slice(0, 8) },
    loafLoadTop: timing.loafLoad.slice().sort((a, b) => b.d - a.d).slice(0, 6),
    dom, scroll: { ...scrollInfo, ...scroll }, trace, clicks, firstInput: final.fi, heaps, perfMetrics, agg, requests: list,
  };
  const file = path.join(OUT, `${prof.name}-r${runIdx}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  console.log('saved', file);
}

function analyzeTrace(tr) {
  const ev = tr.traceEvents || tr;
  const threads = {};
  for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain') threads[`${e.pid}:${e.tid}`] = true;
  const names = ['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint', 'Layerize', 'UpdateLayer', 'CompositeLayers', 'FunctionCall', 'EventDispatch', 'FireAnimationFrame', 'TimerFire', 'RunMicrotasks', 'v8.run', 'MajorGC', 'MinorGC', 'V8.GC_SCAVENGER', 'BlinkGC.AtomicPhase', 'HitTest', 'ScrollLayer', 'IntersectionObserverController::computeIntersections', 'RunTask', 'ParseHTML', 'Commit'];
  const per = {};
  for (const key of Object.keys(threads)) per[key] = { stats: {}, forcedLayouts: 0, forcedLayoutMs: 0, longRunTasks: [] };
  const open = {};
  const add = (key, name, dur, e) => {
    const p = per[key]; if (!p) return;
    const s = (p.stats[name] = p.stats[name] || { n: 0, ms: 0 }); s.n++; s.ms += dur;
    if (name === 'Layout' && e && e.args && e.args.beginData && e.args.beginData.stackTrace) { p.forcedLayouts++; p.forcedLayoutMs += dur; }
    if (name === 'RunTask' && dur > 50) p.longRunTasks.push(Math.round(dur));
  };
  for (const e of ev) {
    const key = `${e.pid}:${e.tid}`; if (!per[key] || !names.includes(e.name)) continue;
    if (e.ph === 'X') add(key, e.name, (e.dur || 0) / 1000, e);
    else if (e.ph === 'B') { (open[key + e.name] = open[key + e.name] || []).push(e); }
    else if (e.ph === 'E') { const st = (open[key + e.name] || []).pop(); if (st) add(key, e.name, (e.ts - st.ts) / 1000, st); }
  }
  // 选事件最多的主线程
  let best = null, bestN = -1;
  for (const [k, p] of Object.entries(per)) { const n = Object.values(p.stats).reduce((a, s) => a + s.n, 0); if (n > bestN) { bestN = n; best = k; } }
  const p = best ? per[best] : null;
  if (p) { for (const s of Object.values(p.stats)) s.ms = Math.round(s.ms * 10) / 10; p.forcedLayoutMs = Math.round(p.forcedLayoutMs * 10) / 10; p.longRunTasks.sort((a, b) => b - a); }
  return { thread: best, ...(p || {}) };
}

for (let attempt = 1; attempt <= 4; attempt++) {
  try { await runOnce(); break; }
  catch (e) { try { await curBrowser?.close(); } catch {} console.error(`attempt ${attempt} failed:`, String(e.message || e).slice(0, 300)); if (attempt === 4) process.exit(1); }
}
