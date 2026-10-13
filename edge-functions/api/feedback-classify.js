// 反馈分类（用户反馈与备选显示 · A 块步 1，overview 分块-A-反馈闭环-Ella.md §二）。
// 纯函数、无依赖：边缘函数 feedback.js 与 Jest 共用。分类只靠「提交类型＋页面路径＋有没有选中原文」，
// 正文关键词只纠偏（改成 join），不做主判。分类只是建议块，认领（assignee）必须是人动手。

export const CATEGORIES = ['typo', 'entry', 'site', 'join', 'other'];
/** 认领人：块名，不记个人，避免公开页暴露人名；owner＝要用户亲自回 */
export const ASSIGNEES = ['catalog', 'web', 'text', 'cv', 'collate', 'layout', 'owner'];

/** 前端 nextjs/src/lib/feedback.ts 的 quotePrefix 给选中原文加的开头；两处必须一致（Jest 对表） */
export const QUOTE_MARK = '【原文】';

const RE_EMAIL = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_JOIN_WORDS = /加入|参与|參與|联系我|聯繫我|聯係我/;
const RE_ANCHOR = /^rd-e-\d+$/; // 阅读器条目锚点，与 feedback.ts 的 withAnchor 一致

function parsePath(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) return null;
  try {
    const u = new URL(pageUrl, 'https://placeholder.invalid');
    return { path: u.pathname, hash: u.hash.replace(/^#/, '') };
  } catch {
    return null;
  }
}

/** 去掉前端拼上的「【原文】……\n\n」，剩下读者自己写的话 */
function userText(content) {
  const s = typeof content === 'string' ? content : '';
  if (!s.startsWith(QUOTE_MARK)) return { text: s, hasQuote: false };
  const i = s.indexOf('\n\n');
  return { text: i < 0 ? '' : s.slice(i + 2), hasQuote: true };
}

/**
 * @param {{type?: string, pageUrl?: string, content?: string}} input
 * @returns {'typo'|'entry'|'site'|'join'|'other'}
 */
export function classifyFeedback(input) {
  const { type, pageUrl, content } = input || {};
  if (type === 'contact') return 'join';

  const { text, hasQuote } = userText(content);
  if (RE_EMAIL.test(text) || RE_JOIN_WORDS.test(text)) return 'join';

  if (type === 'resource') return 'entry';
  if (type === 'bug' || type === 'suggestion') {
    const p = parsePath(pageUrl);
    if (!p) return 'other';
    const reading = /^\/read\//.test(p.path);
    const item = /^\/item\//.test(p.path);
    if (reading) return 'typo';
    if (item) return hasQuote || RE_ANCHOR.test(p.hash) ? 'typo' : 'entry';
    return 'site';
  }
  return 'other';
}

/** 旧记录（没有 category）读时按 type 推，不回写 */
export function legacyCategory(type) {
  if (type === 'bug') return 'site';
  if (type === 'resource') return 'entry';
  if (type === 'contact') return 'join';
  return 'other';
}

/** 建议由哪个块认领；只是建议，不自动写 assignee。typo 查不到版本一律文本块（保守） */
export function suggestAssignee(category) {
  return { typo: 'text', entry: 'catalog', site: 'web', join: 'owner', other: 'collate' }[category] || 'collate';
}
