/**
 * 本地假服务器：一台 HTTP 服务同时扮演 www／data／api／staging／GitHub API，
 * 用 faults 对象注入故障。故障注入演示与单测都用它，不打线上、不刷正式 issue。
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequiredUi } from '../lib/context.mjs';

// 假站点的「当前 UI 版本」跟着 main 的要求走，免得每次 bump book-index-ui 都得改测试
const UI = readRequiredUi(resolve(dirname(fileURLToPath(import.meta.url)), '../..')) || '0.9.7';

export const WORK = 'd59f20aowb9c';
export const ENTITY = 'hixhd2h9bk4b';
const COMMIT = 'abc123abc123';

export function defaultFaults() {
  return {
    homeStatus: 200, prodUi: UI, stagingUi: UI,
    meiliHealth: 200, searchDelayMs: 0, searchHits: 500, worksFilterStatus: 200,
    latestStatus: 200, versionCommit: COMMIT, entryTombstone: false, manifestRootBody: '{"root":"x"}',
    l2Missing: null,
    bookIndexStatus: 200, itemTitle: '史記',
    feedbackItems: [{ id: 'fb_1_a', content: '好', pageUrl: 'https://www.kaiyuanguji.com/', createdAt: new Date().toISOString() }],
    authMeStatus: 401, oauthStatus: 400,
    stagingStatus: 200, robots: 'User-agent: *\nDisallow: /\n',
    tlsDays: 60,
    errorSummary: null, // null = 503（未配置）
    compare: { ahead_by: 0, commits: [] },
  };
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export async function startFake() {
  const faults = defaultFaults();
  const gh = { issues: new Map(), nextId: 1, calls: [] };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    let body = '';
    for await (const c of req) body += c;
    const f = faults;
    const html = (v, extra = '') => `<html><head><meta name="bim-ui-version" content="${v}"/></head><body>${extra}</body></html>`;

    // ── www
    if (p === '/www/') return send(res, f.homeStatus, html(f.prodUi), 'text/html');
    if (p === '/www/book-index') return send(res, f.bookIndexStatus, html(f.prodUi), 'text/html');
    if (p === '/www/api/feedback') return send(res, 200, { success: true, items: f.feedbackItems });
    if (p === '/www/api/auth/me') return send(res, f.authMeStatus, { error: 'x' });
    if (p === '/www/oauth/authorize') {
      return send(res, f.oauthStatus, f.oauthStatus === 503 ? { error: 'temporarily_unavailable' } : { error: 'invalid_client' });
    }
    if (p === '/www/api/track-error') {
      if (!f.errorSummary) return send(res, 503, { success: false });
      if (req.headers.authorization !== 'Bearer tok') return send(res, 401, { success: false });
      return send(res, 200, { success: true, ...f.errorSummary });
    }
    // ── data
    if (p === '/data/latest.json') {
      return send(res, f.latestStatus, { commitId: COMMIT, fullCommitId: 'd'.repeat(40), productionCommitId: 'p'.repeat(40), textCommitId: 't'.repeat(40) });
    }
    // 照线上形态：version.json 写 40 位全哈希，latest.json 写 12 位短哈希
    if (p === '/data/current/version.json') return send(res, 200, { commitId: f.versionCommit === COMMIT ? `${COMMIT}${'0'.repeat(28)}` : f.versionCommit });
    if (p.startsWith('/data/current/entry/')) return send(res, 200, f.entryTombstone ? { _promoted_to: 'zzz' } : { id: 'x' });
    if (p === '/data/h1/manifest-root.json') return send(res, 200, f.manifestRootBody);
    if (p === `/data/v/${COMMIT}/search/meta.json`) {
      const indices = ['work', 'book', 'collection', 'entity'].filter((t) => t !== f.l2Missing).map((type) => ({ type, docCount: 100 }));
      return send(res, 200, { indices });
    }
    // ── api (Meili)
    if (p === '/api/health') return send(res, f.meiliHealth, { status: 'available' });
    const m = /^\/api\/indexes\/(\w+)\/search$/.exec(p);
    if (m) {
      const q = JSON.parse(body || '{}');
      if (m[1] === 'works' && q.filter && f.worksFilterStatus !== 200) return send(res, f.worksFilterStatus, { message: 'not filterable' });
      if (q.q && f.searchDelayMs) await new Promise((r) => setTimeout(r, f.searchDelayMs));
      return send(res, 200, { hits: f.searchHits ? [{ title: '史記' }] : [], estimatedTotalHits: f.searchHits });
    }
    // ── staging
    if (p === '/stg/') return send(res, f.stagingStatus, html(f.stagingUi), 'text/html');
    if (p === '/stg/robots.txt') return send(res, 200, f.robots, 'text/plain');
    if (p.startsWith('/stg/item/')) return send(res, 200, html(f.stagingUi, `<h1>${f.itemTitle}</h1>`), 'text/html');
    // ── GitHub API
    if (p.startsWith('/gh/repos/')) {
      gh.calls.push(`${req.method} ${p}`);
      if (p.includes('/compare/')) return send(res, 200, f.compare);
      if (p.endsWith('/labels') && req.method === 'POST') return send(res, 422, { message: 'exists' });
      if (p.endsWith('/issues') && req.method === 'GET') {
        return send(res, 200, [...gh.issues.values()].filter((i) => i.state === 'open'));
      }
      if (p.endsWith('/issues') && req.method === 'POST') {
        const b = JSON.parse(body);
        const it = { number: gh.nextId++, state: 'open', comments: [], ...b };
        gh.issues.set(it.number, it);
        return send(res, 201, it);
      }
      const cm = /\/issues\/(\d+)\/comments$/.exec(p);
      if (cm) { gh.issues.get(Number(cm[1])).comments.push(JSON.parse(body).body); return send(res, 201, {}); }
      const im = /\/issues\/(\d+)$/.exec(p);
      if (im && req.method === 'PATCH') { Object.assign(gh.issues.get(Number(im[1])), JSON.parse(body)); return send(res, 200, {}); }
    }
    return send(res, 404, { error: 'not found', p });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tlsConnect = (opts, cb) => {
    const s = new EventEmitter();
    s.getPeerCertificate = () => ({ valid_to: new Date(Date.now() + faults.tlsDays * 86400000 + 3600000).toUTCString() });
    s.end = () => {};
    s.destroy = () => {};
    s.authorized = true;
    setImmediate(cb);
    return s;
  };

  return {
    base, faults, gh, tlsConnect,
    reset() { Object.assign(faults, defaultFaults()); },
    close: () => new Promise((r) => server.close(r)),
  };
}
