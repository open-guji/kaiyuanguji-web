import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLcp, judgeTtfb, median, renderMarkdown, type RunLite, type Thresholds } from './gate.ts';

const T: Thresholds = { lcpMs: { 'A1-home': 6000, 'I1-item-page': 10000 }, itemTtfb: { path: '/item/x', samples: 5, minHits: 3, medianMs: 3000 } };
const run = (scenarioId: string, lcp: number | null, errors: string[] = [], profileName = 'fast'): RunLite => ({ scenarioId, profileName, timing: { lcp }, errors });

test('median', () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('judgeLcp：都在门槛内 → 无超标', () => {
    const r = judgeLcp([run('A1-home', 3400), run('I1-item-page', 6700)], T);
    assert.deepEqual(r.breaches, []);
    assert.deepEqual(r.lcp.map((x) => x.lcpMs), [3400, 6700]);
});

test('judgeLcp：超标、场景出错、没观测到 LCP、没跑，都算超标；非 fast 档不算', () => {
    assert.equal(judgeLcp([run('A1-home', 6001), run('I1-item-page', 100)], T).breaches[0].kind, 'lcp');
    assert.equal(judgeLcp([run('A1-home', 100, ['networkidle timeout']), run('I1-item-page', 100)], T).breaches[0].kind, 'run-error');
    assert.equal(judgeLcp([run('A1-home', null), run('I1-item-page', 100)], T).breaches[0].kind, 'run-error');
    assert.equal(judgeLcp([run('A1-home', 100)], T).breaches.length, 1); // I1 没跑
    assert.equal(judgeLcp([run('A1-home', 99999, [], '4g'), run('A1-home', 100), run('I1-item-page', 100)], T).breaches.length, 0);
});

const s = (ms: number, cacheStatus: string | null = 'Cache Hit', status = 200) => ({ ms, cacheStatus, status });

test('judgeTtfb：只算 Cache Hit 的中位数', () => {
    const ok = judgeTtfb([s(9000, 'Cache Miss'), s(500), s(900), s(700), s(800)], T.itemTtfb);
    assert.equal(ok.breach, null);
    assert.equal(ok.info.hits, 4);
    assert.equal(ok.info.medianMs, 750);
    const bad = judgeTtfb([s(3500), s(4000), s(3200), s(100, 'Cache Miss'), s(3100)], T.itemTtfb);
    assert.equal(bad.breach?.kind, 'ttfb');
    assert.equal(bad.info.medianMs, 3350);
});

test('judgeTtfb：命中样本不足只警告；全非 200 算超标；Cache Refresh Hit 也算命中', () => {
    const few = judgeTtfb([s(9000, 'Cache Miss'), s(9000, 'Cache Miss'), s(500), s(500), s(500, null)], T.itemTtfb);
    assert.equal(few.breach, null);
    assert.match(few.warning ?? '', /只有 2 次 Cache Hit/);
    assert.equal(judgeTtfb([s(100, 'Cache Hit', 502), s(100, 'Cache Hit', 502)], T.itemTtfb).breach?.kind, 'ttfb');
    assert.equal(judgeTtfb([s(100, 'Cache Refresh Hit'), s(100, 'Cache Refresh Hit'), s(100, 'Cache Hit')], T.itemTtfb).info.hits, 3);
});

test('renderMarkdown：未通过时列出超标项', () => {
    const md = renderMarkdown('https://x', { ok: false, breaches: [{ kind: 'lcp', subject: 'A1-home', actual: 7000, limit: 6000, message: 'A1-home：LCP 7000ms 超过 6000ms' }], warnings: ['w1'], lcp: [{ scenarioId: 'A1-home', lcpMs: 7000, limitMs: 6000 }], ttfb: null });
    assert.match(md, /未通过/);
    assert.match(md, /A1-home：LCP 7000ms/);
    assert.match(md, /w1/);
});
