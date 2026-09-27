/**
 * 告警状态机（纯函数，单测见 test/state.test.mjs）。
 *
 * 规矩（任务书 §一）：
 *   · 连续 OPEN_AFTER（=2）次失败才开 issue——一次公网抖动不叫醒人；
 *   · 已开的 issue，持续失败只在「失败内容变了」或距上次评论满 REMIND（=6h）时补一条评论；
 *   · 恢复（ok／warn）即自动关闭并评论恢复时间与持续时长；
 *   · skip（未配置、依赖缺失）不计失败也不算恢复：状态原样保留，不刷也不关。
 *
 * 状态只存「每个检查项最近的计数、对应 issue 号」，放 Actions cache（见 monitor.yml），
 * 丢了也没关系：reconcile() 会从仓里 open 的 monitor issue 把「正在告警」找回来，
 * 最坏情况是一次新故障晚一轮开单。
 */
export const OPEN_AFTER = 2;
export const REMIND_MS = 6 * 3600 * 1000;

export function emptyState() {
  return { version: 1, checks: {}, baselines: {} };
}

function blank() {
  return { fails: 0, issue: null, sig: null, lastCommentAt: null, firstFailAt: null, lastStatus: null };
}

/**
 * @param prev   该检查项的上次状态（可为 undefined）
 * @param result 本次结果 { status: 'ok'|'fail'|'warn'|'skip', sig?, detail? }
 * @param now    毫秒时间戳
 * @returns { next, action }  action ∈ null | { type: 'open'|'comment'|'close', ... }
 */
export function decide(prev, result, now, { openAfter = OPEN_AFTER, remindMs = REMIND_MS } = {}) {
  const p = { ...blank(), ...(prev || {}) };
  const sig = result.sig ?? result.detail ?? '';

  if (result.status === 'skip') {
    return { next: { ...p, lastStatus: 'skip' }, action: null };
  }

  if (result.status === 'ok' || result.status === 'warn') {
    const next = { ...blank(), lastStatus: result.status };
    if (p.issue) {
      return {
        next,
        action: { type: 'close', issue: p.issue, since: p.firstFailAt, durationMs: p.firstFailAt ? now - p.firstFailAt : null },
      };
    }
    return { next, action: null };
  }

  // fail
  const fails = p.fails + 1;
  const firstFailAt = p.firstFailAt ?? now;
  const base = { ...p, fails, firstFailAt, lastStatus: 'fail' };

  if (!p.issue) {
    if (fails >= openAfter) {
      return { next: { ...base, sig, lastCommentAt: now }, action: { type: 'open', fails } };
    }
    return { next: { ...base, sig }, action: null };
  }

  const changed = sig !== p.sig;
  const due = p.lastCommentAt == null || now - p.lastCommentAt >= remindMs;
  if (changed || due) {
    return {
      next: { ...base, sig, lastCommentAt: now },
      action: { type: 'comment', issue: p.issue, reason: changed ? 'changed' : 'remind', fails },
    };
  }
  return { next: { ...base, sig }, action: null };
}

/**
 * 用仓里实际 open 的 monitor issue 校正状态：
 *   · 状态里记着 issue、但它已被人手动关了 → 忘掉它（再失败会重新开）；
 *   · 状态丢了（cache 过期）、但仓里有 open 的 → 认回来，视为已在告警。
 * @param openIssues Map<checkId, issueNumber>
 */
export function reconcile(checkState, openIssues, { openAfter = OPEN_AFTER } = {}) {
  const out = {};
  const ids = new Set([...Object.keys(checkState), ...openIssues.keys()]);
  for (const id of ids) {
    const s = { ...blank(), ...(checkState[id] || {}) };
    const open = openIssues.get(id) ?? null;
    if (s.issue && s.issue !== open) {
      s.issue = open; // 手动关掉了（open=null），或被换成另一张单
    } else if (!s.issue && open) {
      s.issue = open;
      s.fails = Math.max(s.fails, openAfter);
    }
    out[id] = s;
  }
  return out;
}

/**
 * 基线：记最近 N 个观测值，取中位数。用于「命中数不低于基线 90%」这类相对阈值。
 * 返回 { baseline, values }；baseline 在样本不足 minSamples 时为 null（不判）。
 */
export function pushBaseline(values = [], v, { keep = 48, minSamples = 3 } = {}) {
  const arr = [...values, v].filter((x) => Number.isFinite(x)).slice(-keep);
  return { values: arr, baseline: medianOf(values, minSamples) };
}

export function medianOf(values = [], minSamples = 3) {
  const a = values.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (a.length < minSamples) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
