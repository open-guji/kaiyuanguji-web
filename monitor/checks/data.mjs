/**
 * B 类：数据监测（每小时一次；在 15 分钟探测那个 job 里逢整点那一轮顺带跑）。
 * 需要凭据的项（ERROR_VIEW_TOKEN／FEEDBACK_ADMIN_TOKEN）缺配置时一律 skip 并注明「未配置」，
 * 不让整个监控报红（任务书 §三）。
 */
import { request, parseJson, bust, describe } from '../lib/http.mjs';
import { part, aggregate } from '../lib/result.mjs';
import { getLatest } from './probe.mjs';

const H = 3600 * 1000;

async function summary(ctx, path, token, base = ctx.cfg.www) {
  // limit=1：汇总接口没上线的老部署会把这个请求当成列表读，限 1 条，免得把整页带 IP 的记录拉过来
  const r = await request(`${base}${path}?summary=1&window=1h&limit=1&_=${Date.now()}`, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: ctx.cfg.timeoutMs,
  });
  return { r, j: parseJson(r.text) };
}

/** 汇总接口的非 200 怎么判：503=生产没配变量（skip）；401=两边 token 对不上（fail，要人修） */
function summaryFailure(label, r, j, envName) {
  if (r.status === 503) return part(label, 'skip', `生产未配 ${envName}（503）`, '', '待用户在 EdgeOne 控制台配置');
  if (r.status === 401) return part(label, 'fail', '401', '200', `GitHub secret 与生产的 ${envName} 不一致`);
  if (r.status === 200 && j && j.count === undefined) return part(label, 'skip', '汇总接口未上线', '', '本 PR 合并部署后生效');
  return part(label, 'fail', describe(r), '200');
}

/**
 * B1 前端错误数：最近 1 小时 > max(floor, 前 23 小时每小时均值 × factor) 就报。
 * 均值刻意不含本小时——否则一次暴涨会把自己的基线也抬上去。
 */
export async function errorSpike(ctx) {
  const { cfg } = ctx;
  const id = 'B1-errors';
  const name = '前端错误数';
  if (!cfg.errorViewToken) {
    return aggregate(id, name, [part('ERROR_VIEW_TOKEN', 'skip', '未配置', '', 'GitHub secret 未放，本项跳过')]);
  }
  const { r, j } = await summary(ctx, '/api/track-error', cfg.errorViewToken);
  if (r.status !== 200 || !j?.success || j.count === undefined) {
    return aggregate(id, name, [summaryFailure('正式站错误汇总接口', r, j, 'ERROR_VIEW_TOKEN'), await stagingSummaryPart(ctx)]);
  }
  const avg = Math.max(0, (j.count24h - j.count) / 23);
  const stagingPart = await stagingSummaryPart(ctx);
  const limit = Math.max(cfg.errorFloor, avg * cfg.errorFactor);
  const top = (j.top || []).map((t) => `${t.count}×[${t.kind}] ${t.message}`).join('；') || '（无）';
  return aggregate(id, name, [
    part('最近 1 小时错误数', j.count > limit ? 'fail' : 'ok', j.count, `≤ ${limit.toFixed(1)}（max(${cfg.errorFloor}, 均值 ${avg.toFixed(2)}×${cfg.errorFactor})）`),
    part('前 5 种', 'ok', top, '', '仅供排查'),
    stagingPart,
  ]);
}

/**
 * 测试站的错误汇总只作参考（不参与判定，永远不 fail）：看 token 在测试站是否也生效。
 */
async function stagingSummaryPart(ctx) {
  const { r, j } = await summary(ctx, '/api/track-error', ctx.cfg.errorViewToken, ctx.cfg.staging);
  if (r.status === 200 && j?.success && j.count !== undefined) {
    return part('测试站错误汇总（参考）', 'ok', `最近 1h ${j.count}，24h ${j.count24h}`, '', '不参与判定');
  }
  const why = r.status === 200 ? '汇总接口未上线（老部署）' : r.status === 503 ? '503：测试站未配 ERROR_VIEW_TOKEN' : r.status === 401 ? '401：token 与测试站不一致' : describe(r);
  return part('测试站错误汇总（参考）', 'skip', why, '', '不参与判定');
}

/** B2 反馈量：最近 1 小时新反馈 > N 条就报（防刷） */
export async function feedbackRate(ctx) {
  const { cfg, now } = ctx;
  const id = 'B2-feedback-rate';
  const name = '反馈量';
  const max = cfg.feedbackMaxPerHour;
  const token = process.env.FEEDBACK_ADMIN_TOKEN || '';
  if (token) {
    const { r, j } = await summary(ctx, '/api/feedback', token);
    if (r.status === 200 && j?.success && j.count !== undefined) {
      return aggregate(id, name, [part('最近 1 小时新反馈（全部）', j.count > max ? 'fail' : 'ok', j.count, `≤ ${max}`)]);
    }
    const f = summaryFailure('反馈汇总接口', r, j, 'FEEDBACK_ADMIN_TOKEN');
    if (f.status === 'fail') return aggregate(id, name, [f]);
    // skip → 往下退回公开列表
  }
  // 退路：公开列表只含公开可见的反馈（被隐藏的刷屏条目数不到），是下界
  let items = ctx.memo.feedbackItems;
  if (!items) {
    const r = await request(bust(`${cfg.www}/api/feedback?limit=100`), { timeoutMs: cfg.timeoutMs });
    const j = r.status === 200 ? parseJson(r.text) : undefined;
    if (!j?.success) return aggregate(id, name, [part('公开反馈列表', 'fail', describe(r), '200')]);
    items = j.items || [];
  }
  const n = items.filter((it) => { const t = Date.parse(it.createdAt); return t && now - t <= H && now - t >= -5 * 60 * 1000; }).length;
  return aggregate(id, name, [
    part('最近 1 小时新反馈（仅公开可见）', n > max ? 'fail' : 'ok', n, `≤ ${max}`, token ? '管理汇总不可用，退回公开列表' : '未配 FEEDBACK_ADMIN_TOKEN，只数得到公开可见的，是下界'),
  ]);
}

/**
 * B3 数据新鲜度：三个数据仓 main 上有、正式站 latest.json 还没收的提交里，
 * 最早那条已超过 N 小时 ⇒ 管线卡住（2026-08 跨仓 PAT 失效、数据 5 天没上线那类）。
 */
export async function dataFreshness(ctx) {
  const { cfg, now } = ctx;
  const id = 'B3-freshness';
  const name = '数据新鲜度';
  const latest = await getLatest(ctx);
  if (!latest.json) return aggregate(id, name, [part('latest.json', 'fail', latest.desc, '可取')]);
  const live = {
    draft: latest.json.fullCommitId || latest.json.commitId,
    production: latest.json.productionCommitId,
    text: latest.json.textCommitId,
  };
  const parts = [];
  for (const [k, repo] of Object.entries(cfg.dataRepos)) {
    const sha = live[k];
    if (!sha) { parts.push(part(repo, 'fail', 'latest.json 缺该仓 commit', '有')); continue; }
    const headers = { accept: 'application/vnd.github+json' };
    if (cfg.githubToken) headers.authorization = `Bearer ${cfg.githubToken}`;
    const r = await request(`${cfg.githubApi}/repos/${repo}/compare/${sha}...main`, { headers, timeoutMs: cfg.timeoutMs });
    const j = r.status === 200 ? parseJson(r.text) : undefined;
    if (r.status === 404 || r.status === 403) {
      parts.push(part(repo, 'skip', `GitHub API ${r.status}`, '', '无权读该仓（私有仓需给 workflow 一个能读它的 token）'));
      continue;
    }
    if (!j) { parts.push(part(repo, 'fail', describe(r), 'GitHub compare 200')); continue; }
    const ahead = j.ahead_by ?? 0;
    if (!ahead) { parts.push(part(repo, 'ok', `线上即 main（${sha.slice(0, 7)}）`, `落后 ≤ ${cfg.freshnessMaxHours}h`)); continue; }
    const oldest = (j.commits || [])
      .map((c) => Date.parse(c.commit?.committer?.date || c.commit?.author?.date))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const lagH = oldest ? (now - oldest) / H : null;
    parts.push(part(
      repo,
      lagH != null && lagH > cfg.freshnessMaxHours ? 'fail' : 'ok',
      `落后 ${ahead} 个提交，最早一条 ${lagH == null ? '时间未知' : `${lagH.toFixed(1)}h 前`}`,
      `≤ ${cfg.freshnessMaxHours}h`,
    ));
  }
  return aggregate(id, name, parts);
}

export const DATA_CHECKS = [errorSpike, feedbackRate, dataFreshness];
