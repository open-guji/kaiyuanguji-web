/**
 * GitHub Issue 告警。每个检查项至多一张 open 的单，正文首行藏一个标记
 * `<!-- monitor-check:ID -->`，靠它把单认回检查项（标题可以人手改，标记别删）。
 * 邮件由 GitHub 的 issue 通知发出（仓主默认收到），不另接邮件服务。
 */
import { request, parseJson } from './http.mjs';
import { renderCheck } from './result.mjs';

export const MARKER = (id) => `<!-- monitor-check:${id} -->`;
const MARKER_RE = /<!-- monitor-check:([A-Za-z0-9_-]+) -->/;

export function makeGithub({ api, repo, token, label = 'monitor', timeoutMs = 20000 }) {
  const call = async (method, path, body) => {
    const r = await request(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`GitHub ${method} ${path} → ${r.status || r.error} ${r.text.slice(0, 200)}`);
    }
    return parseJson(r.text);
  };

  return {
    label,
    async ensureLabel() {
      try {
        await call('POST', '/labels', { name: label, color: 'b60205', description: '线上监控自动告警（monitor/）' });
      } catch (e) {
        if (!/→ 422/.test(e.message)) throw e; // 422 = 已存在
      }
    },
    /** @returns Map<checkId, issueNumber> */
    async listOpen() {
      const out = new Map();
      for (let page = 1; page <= 5; page += 1) {
        const arr = await call('GET', `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`);
        for (const it of arr || []) {
          if (it.pull_request) continue;
          const m = MARKER_RE.exec(it.body || '');
          if (m && !out.has(m[1])) out.set(m[1], it.number);
        }
        if (!arr || arr.length < 100) break;
      }
      return out;
    },
    async open(title, body) {
      const it = await call('POST', '/issues', { title, body, labels: [label] });
      return it.number;
    },
    async comment(number, body) {
      await call('POST', `/issues/${number}/comments`, { body });
    },
    async close(number, body) {
      await call('POST', `/issues/${number}/comments`, { body });
      await call('PATCH', `/issues/${number}`, { state: 'closed', state_reason: 'completed' });
    },
  };
}

const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
function dur(ms) {
  if (ms == null) return '未知';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

export function issueTitle(r, prefix = '') {
  return `${prefix}🔴 [监控] ${r.id} ${r.name}`;
}

export function openBody(r, { now, runUrl, fails }) {
  return [
    MARKER(r.id),
    `**${r.id} ${r.name}** 连续 ${fails} 次失败，自动开单。恢复后本单会自动关闭。`,
    '',
    `- 首次失败：${fmt(now)}（本单开于第 ${fails} 次）`,
    `- 运行：${runUrl}`,
    `- 这项测什么、阈值、误报怎么调：\`monitor/README.md\` 的「${r.id}」一节`,
    '',
    renderCheck(r),
  ].join('\n');
}

export function commentBody(r, { now, runUrl, reason, fails }) {
  const why = reason === 'changed' ? '失败内容有变化' : '仍在失败（每 6 小时提醒一次）';
  return [`**${why}**：${fmt(now)}，已连续 ${fails} 次。运行：${runUrl}`, '', renderCheck(r)].join('\n');
}

export function closeBody(r, { now, runUrl, durationMs }) {
  return [`✅ **已恢复**：${fmt(now)}，故障持续约 ${dur(durationMs)}。自动关闭。运行：${runUrl}`, '', renderCheck(r)].join('\n');
}
