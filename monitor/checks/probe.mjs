/**
 * A 类：主动探测（每 15 分钟，纯 HTTP，单次 < 2 分钟）。
 * 每个导出的检查 = async (ctx) => aggregate(...)；ctx 见 run.mjs 的 buildContext。
 *
 * 教训沿用 ops/health-probe.sh（本套件取代了它）：探活要探**用户实际走的那条路径**，
 * 不是探「服务还活着吗」——/health 绿、裸查询 200，前端带 filter 的查询照样可能 400。
 */
import tls from 'node:tls';
import { request, parseJson, bust, describe } from '../lib/http.mjs';
import { part, aggregate } from '../lib/result.mjs';
import { cmpVersion, uiVersionFromHtml } from '../lib/version.mjs';

const H = 3600 * 1000;

/** A1 正式站首页：200 且带版本 meta（meta 丢了 e2e 的版本门禁会静默跳过一批用例） */
export async function homePage(ctx) {
  const { cfg } = ctx;
  const r = await request(bust(`${cfg.www}/`), { timeoutMs: cfg.timeoutMs });
  const v = r.status === 200 ? uiVersionFromHtml(r.text) : null;
  ctx.memo.prodUiVersion = v;
  return aggregate('A1-home', '正式站首页', [
    part('首页', r.status === 200 ? 'ok' : 'fail', describe(r), 'HTTP 200'),
    part('bim-ui-version meta', r.status !== 200 ? 'skip' : (v ? 'ok' : 'fail'), v ?? '（缺）', '存在'),
  ]);
}

/**
 * A1 部署停更：main 的 nextjs/package.json 要求 book-index-ui ≥ X，
 * 测试站（push main 自动部署）须在 stagingLagHours 内跟上，
 * 正式站（人手动 promote）须在 prodLagHours 内跟上；宽限期内只记 warn。
 */
export async function deployLag(ctx) {
  const { cfg, required, pkgChangedAt, now } = ctx;
  if (!required) {
    return aggregate('A1-deploy-lag', '部署停更', [part('main 要求版本', 'skip', '读不到 nextjs/package.json', '')]);
  }
  const ageH = pkgChangedAt ? (now - pkgChangedAt) / H : null;
  const ageText = ageH == null ? '改动时间未知' : `main 改版本后 ${ageH.toFixed(1)} 小时`;

  const s = await request(bust(`${cfg.staging}/`), { timeoutMs: cfg.timeoutMs });
  const sv = s.status === 200 ? uiVersionFromHtml(s.text) : null;
  let pv = ctx.memo.prodUiVersion;
  if (pv === undefined) {
    const p = await request(bust(`${cfg.www}/`), { timeoutMs: cfg.timeoutMs });
    pv = p.status === 200 ? uiVersionFromHtml(p.text) : null;
  }

  const judge = (label, v, graceH) => {
    if (!v) return part(label, 'skip', '读不到版本', `≥ ${required}`, '首页检查另报');
    if (cmpVersion(v, required) >= 0) return part(label, 'ok', v, `≥ ${required}`);
    const late = ageH != null && ageH > graceH;
    return part(label, late ? 'fail' : 'warn', v, `≥ ${required}（宽限 ${graceH}h）`, ageText);
  };
  return aggregate('A1-deploy-lag', '部署停更', [
    judge('测试站 bim-ui-version', sv, cfg.stagingLagHours),
    judge('正式站 bim-ui-version', pv, cfg.prodLagHours),
  ]);
}

function meili(ctx, index, payload) {
  return request(`${ctx.cfg.api}/indexes/${index}/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.cfg.meiliKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: ctx.cfg.timeoutMs,
  });
}

/**
 * A2 搜索 L1：照前端形态（带 is_draft 过滤）搜「史記」——有命中、耗时 < 3s、
 * 命中数不低于基线 90%（防索引塌缩）。另查四个索引带过滤的空查询非空
 * （2026-09-14 三索引被清空、2026-09-21 works 丢 filterable 这两类事故）。
 */
export async function searchL1(ctx) {
  const { cfg } = ctx;
  const parts = [];
  const h = await request(`${cfg.api}/health`, { timeoutMs: cfg.timeoutMs });
  parts.push(part('Meili /health', h.status === 200 ? 'ok' : 'fail', describe(h), 'HTTP 200'));

  const r = await meili(ctx, 'works', { q: cfg.searchQuery, limit: 1, filter: 'is_draft = false' });
  const j = r.status === 200 ? parseJson(r.text) : undefined;
  const hits = j?.estimatedTotalHits ?? j?.totalHits;
  parts.push(part(`搜「${cfg.searchQuery}」`, r.status === 200 && j ? 'ok' : 'fail', describe(r), 'HTTP 200，前端查询形态'));
  if (j) {
    parts.push(part('命中', hits > 0 ? 'ok' : 'fail', hits ?? '（无）', '> 0'));
    parts.push(part('耗时', r.ms < cfg.searchMaxMs ? 'ok' : 'fail', `${r.ms}ms`, `< ${cfg.searchMaxMs}ms`));
    const key = `searchHits:${cfg.searchQuery}`;
    const b = ctx.baseline(key);
    if (b == null) {
      parts.push(part('命中数 vs 基线', 'skip', hits, `≥ 基线×${cfg.searchBaselineRatio}`, '基线样本不足，先攒'));
    } else {
      const ok = hits >= b * cfg.searchBaselineRatio;
      parts.push(part('命中数 vs 基线', ok ? 'ok' : 'fail', hits, `≥ ${Math.ceil(b * cfg.searchBaselineRatio)}（基线 ${b}）`));
    }
    // 只有正常时才进基线：塌缩的数不能把基线拖下来
    if (hits > 0 && (b == null || hits >= b * cfg.searchBaselineRatio)) ctx.record(key, hits);
  }

  for (const idx of ['works', 'books', 'entities', 'collections']) {
    const q = await meili(ctx, idx, { q: '', limit: 0, filter: 'is_draft = false' });
    const n = q.status === 200 ? parseJson(q.text)?.estimatedTotalHits : undefined;
    const ok = q.status === 200 && n >= 1;
    parts.push(part(`索引 ${idx}（带过滤）`, ok ? 'ok' : 'fail', q.status === 200 ? `${n} 条${n >= 1000 ? '（封顶值）' : ''}` : describe(q), '200 且 ≥ 1'));
  }
  return aggregate('A2-search-l1', '搜索 L1（Meilisearch）', parts);
}

/** A2 搜索 L2：兜底分片清单可取、四类齐全。L1 挂时它是唯一的搜索。 */
export async function searchL2(ctx) {
  const { cfg } = ctx;
  const latest = await getLatest(ctx);
  if (!latest.commitId) {
    return aggregate('A2-search-l2', '搜索 L2（分片兜底）', [part('latest.json', 'fail', latest.desc, '可取且有 commitId')]);
  }
  const r = await request(bust(`${cfg.data}/v/${latest.commitId}/search/meta.json`), { timeoutMs: cfg.timeoutMs });
  const meta = r.status === 200 ? parseJson(r.text) : undefined;
  const parts = [part('分片清单 meta.json', meta ? 'ok' : 'fail', describe(r), 'HTTP 200 且 JSON')];
  if (meta) {
    const by = new Map((meta.indices || []).map((i) => [i.type, i]));
    for (const t of ['work', 'book', 'collection', 'entity']) {
      const c = by.get(t)?.docCount;
      parts.push(part(`L2 ${t}`, c > 0 ? 'ok' : 'fail', c ?? '（缺）', '> 0'));
    }
  }
  return aggregate('A2-search-l2', '搜索 L2（分片兜底）', parts);
}

/** 同一次运行里 latest.json 只取一次 */
export async function getLatest(ctx) {
  if (!ctx.memo.latest) {
    ctx.memo.latest = (async () => {
      const r = await request(bust(`${ctx.cfg.data}/latest.json`), { timeoutMs: ctx.cfg.timeoutMs });
      const j = r.status === 200 ? parseJson(r.text) : undefined;
      return { r, json: j, commitId: j?.commitId ?? null, desc: j ? describe(r) : `${describe(r)}${r.status === 200 ? '，JSON 解析失败' : ''}` };
    })();
  }
  return ctx.memo.latest;
}

/** A3 数据桶：发布指针、版本文件、锚点条目、h1 根清单都 200 且 JSON 可解析 */
export async function dataBucket(ctx) {
  const { cfg, anchors } = ctx;
  const parts = [];
  const latest = await getLatest(ctx);
  parts.push(part('latest.json', latest.commitId ? 'ok' : 'fail', latest.desc, '200、JSON、有 commitId'));

  const jsonProbe = async (label, path) => {
    const r = await request(bust(`${cfg.data}/${path}`), { timeoutMs: cfg.timeoutMs });
    const j = r.status === 200 ? parseJson(r.text) : undefined;
    parts.push(part(label, j !== undefined ? 'ok' : 'fail', r.status === 200 && j === undefined ? `${describe(r)}，JSON 解析失败` : describe(r), '200 且 JSON'));
    return j;
  };
  const ver = await jsonProbe('current/version.json', 'current/version.json');
  if (ver && latest.commitId && ver.commitId && ver.commitId !== latest.commitId) {
    // 部署刚切换的几分钟内可能短暂不一致；连续 2 次才开单，足以滤掉
    parts.push(part('version.json 与 latest.json 同版本', 'fail', `${ver.commitId} ≠ ${latest.commitId}`, '相同', 'CDN 未刷新'));
  }
  for (const [kind, id] of Object.entries(anchors.entries)) {
    const e = await jsonProbe(`锚点 ${kind} ${id}`, `current/entry/${id}.json${latest.commitId ? `?v=${latest.commitId}` : ''}`);
    if (e && e._promoted_to) parts.push(part(`锚点 ${kind} 非墓碑`, 'fail', `已升格为 ${e._promoted_to}`, '无 _promoted_to', '换 e2e/fixtures/anchors.ts 的锚点'));
  }
  await jsonProbe('h1/manifest-root.json', 'h1/manifest-root.json');
  return aggregate('A3-data-bucket', '数据桶', parts);
}

/** A4 条目页：正式站 /book-index?id=、测试站 SSR /item/<id> 含书名 */
export async function itemPages(ctx) {
  const { cfg, anchors } = ctx;
  const id = anchors.entries.work;
  const a = await request(bust(`${cfg.www}/book-index?id=${id}`), { timeoutMs: cfg.timeoutMs });
  const b = await request(bust(`${cfg.staging}/item/${id}`), { timeoutMs: cfg.timeoutMs });
  const has = b.status === 200 && b.text.includes(anchors.workTitle);
  return aggregate('A4-item-pages', '条目页', [
    part(`正式站 /book-index?id=${id}`, a.status === 200 ? 'ok' : 'fail', describe(a), 'HTTP 200'),
    part(`测试站 /item/${id}`, b.status === 200 ? 'ok' : 'fail', describe(b), 'HTTP 200'),
    part('测试站 HTML 含书名', b.status !== 200 ? 'skip' : (has ? 'ok' : 'fail'), has ? `含「${anchors.workTitle}」` : '不含', `含「${anchors.workTitle}」`, 'SSR 回退成空壳时会缺'),
  ]);
}

// F1 回归：公开反馈列表里不许出现邮箱或手机号
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
export const PHONE_RE = /(?<![\d])1[3-9]\d{9}(?![\d])/;
const SKIP_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);

/** 找公开反馈里泄露的个人信息，返回命中的「条目id.字段」列表（不回显内容本身） */
export function findPii(items) {
  const hits = [];
  for (const it of items || []) {
    for (const [k, v] of Object.entries(it || {})) {
      if (SKIP_FIELDS.has(k) || typeof v !== 'string') continue;
      if (EMAIL_RE.test(v)) hits.push(`${it.id}.${k}(邮箱)`);
      else if (PHONE_RE.test(v)) hits.push(`${it.id}.${k}(手机)`);
    }
  }
  return hits;
}

/** A5 边缘函数 */
export async function edgeFunctions(ctx) {
  const { cfg } = ctx;
  const parts = [];

  const f = await request(bust(`${cfg.www}/api/feedback?limit=100`), { timeoutMs: cfg.timeoutMs });
  const fj = f.status === 200 ? parseJson(f.text) : undefined;
  parts.push(part('GET /api/feedback', fj?.success ? 'ok' : 'fail', describe(f), '200 且 success'));
  if (fj?.success) {
    ctx.memo.feedbackItems = fj.items || [];
    const pii = findPii(fj.items);
    parts.push(part('公开列表无邮箱／手机号', pii.length ? 'fail' : 'ok', pii.length ? pii.slice(0, 5).join('，') : `扫 ${fj.items?.length ?? 0} 条 0 命中`, '0 命中', 'F1 脱敏回归'));
  }

  const me = await request(`${cfg.www}/api/auth/me`, { timeoutMs: cfg.timeoutMs });
  parts.push(part('GET /api/auth/me（未登录）', me.status === 401 ? 'ok' : 'fail', describe(me), 'HTTP 401'));

  // 不带参数：配置齐时应 400（invalid_client 等）；生产没配 OAuth 变量时是 503 temporarily_unavailable
  // ——后者是「未配置」不是故障，记 warn；404／5xx 平台错误／连不上才算挂
  const o = await request(`${cfg.www}/oauth/authorize`, { timeoutMs: cfg.timeoutMs });
  const oj = parseJson(o.text);
  let os = 'fail';
  let note = '';
  if (o.status === 400 || o.status === 302) os = 'ok';
  else if (o.status === 503 && oj?.error === 'temporarily_unavailable') { os = 'warn'; note = '生产未配 OAuth 环境变量'; }
  parts.push(part('GET /oauth/authorize（无参数）', os, describe(o), '400／302（未配置时 503 记 warn）', note));

  return aggregate('A5-edge', '边缘函数', parts);
}

/** A6 测试站：首页 200，robots.txt 全禁（测试站不许被搜索引擎收录） */
export async function staging(ctx) {
  const { cfg } = ctx;
  const h = await request(bust(`${cfg.staging}/`), { timeoutMs: cfg.timeoutMs });
  const r = await request(bust(`${cfg.staging}/robots.txt`), { timeoutMs: cfg.timeoutMs });
  const disallowAll = r.status === 200 && robotsDisallowsAll(r.text);
  return aggregate('A6-staging', '测试站', [
    part('测试站首页', h.status === 200 ? 'ok' : 'fail', describe(h), 'HTTP 200'),
    part('robots.txt 全禁', disallowAll ? 'ok' : 'fail', r.status === 200 ? (disallowAll ? 'User-agent: * / Disallow: /' : '不是全禁') : describe(r), 'User-agent: * + Disallow: /'),
  ]);
}

export function robotsDisallowsAll(text) {
  // 找 User-agent: * 那一组，组内要有 `Disallow: /`（整站）
  const lines = String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  let inStar = false;
  for (const l of lines) {
    const m = l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') inStar = v === '*';
    else if (inStar && k === 'disallow' && v === '/') return true;
  }
  return false;
}

/** 取证书剩余天数；可注入 connect 以便单测 */
export function certDaysLeft(host, { port = 443, timeoutMs = 15000, now = Date.now(), connect = tls.connect } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert?.valid_to) return finish({ error: '拿不到证书' });
      const until = Date.parse(cert.valid_to);
      finish({ days: Math.floor((until - now) / 86400000), validTo: cert.valid_to, authorized: sock.authorized, authError: sock.authorizationError });
    });
    sock.on('timeout', () => { sock.destroy(); finish({ error: `超时 ${timeoutMs}ms` }); });
    sock.on('error', (e) => finish({ error: e.code || e.message }));
  });
}

/** A7 TLS：四个域名证书剩余 > 14 天 */
export async function tlsCerts(ctx) {
  const { cfg, now } = ctx;
  const results = await Promise.all(cfg.tlsHosts.map((h) => certDaysLeft(h, { now, timeoutMs: cfg.timeoutMs, connect: ctx.tlsConnect })));
  const parts = cfg.tlsHosts.map((h, i) => {
    const r = results[i];
    if (r.error) return part(h, 'fail', r.error, `剩余 > ${cfg.tlsMinDays} 天`);
    return part(h, r.days > cfg.tlsMinDays ? 'ok' : 'fail', `剩 ${r.days} 天（至 ${r.validTo}）`, `> ${cfg.tlsMinDays} 天`);
  });
  return aggregate('A7-tls', 'TLS 证书', parts);
}

export const PROBE_CHECKS = [homePage, deployLag, searchL1, searchL2, dataBucket, itemPages, edgeFunctions, staging, tlsCerts];
