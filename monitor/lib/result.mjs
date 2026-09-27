/**
 * 一个检查项 = 若干「子项」，每个子项有 名字／阈值／实测值／结论。
 * 检查项结论取子项最坏的：fail > warn > ok；全部 skip 才是 skip。
 *
 * sig（失败签名）只由「哪些子项失败」组成、不含实测数值——
 * 否则每次耗时差几毫秒都算「状态变化」，持续故障会每 15 分钟刷一条评论。
 */
const RANK = { skip: 0, ok: 1, warn: 2, fail: 3 };

export function part(label, status, value, threshold, note) {
  return { label, status, value: value ?? '', threshold: threshold ?? '', note: note ?? '' };
}

export function aggregate(id, name, parts) {
  let status = 'skip';
  for (const p of parts) {
    if (p.status === 'skip') continue;
    if (status === 'skip' || RANK[p.status] > RANK[status]) status = p.status;
  }
  const bad = parts.filter((p) => p.status === 'fail').map((p) => p.label);
  const warns = parts.filter((p) => p.status === 'warn').map((p) => p.label);
  return {
    id,
    name,
    status,
    parts,
    sig: bad.length ? `fail:${bad.join('|')}` : (warns.length ? `warn:${warns.join('|')}` : status),
  };
}

/** 检查项自己抛异常时（代码 bug 或意外响应），记为 fail 而不是让整次运行崩掉 */
export function crashed(id, name, e) {
  return aggregate(id, name, [part('检查自身出错', 'fail', String(e?.stack || e).split('\n')[0], '不抛异常')]);
}

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', skip: '⏭️' };
export const icon = (s) => ICON[s] || '?';

/** 渲染成 Markdown（issue 正文、Step Summary 共用） */
export function renderCheck(r) {
  const rows = r.parts.map((p) => `| ${icon(p.status)} | ${p.label} | ${esc(p.value)} | ${esc(p.threshold)} | ${esc(p.note)} |`);
  return [
    `### ${icon(r.status)} ${r.id} ${r.name}`,
    '',
    '| | 子项 | 实测 | 阈值 | 说明 |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
