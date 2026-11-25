// 功能（capability）权限：代码里一律问「有没有 X 功能」，不问「是不是审阅者」。
// 有效权限 ＝ 角色预设 ∪ 成员记录 caps 里未过期的项。成员记录：{ role, caps?: { "<功能>": { exp?: 毫秒时间戳, src?: 'grant'|'paid'|'review-score'|'occupation' } } }
// 付费暂未启用，只留口子：src='paid' 的项带 exp，到期自动失效。
export const CAPS = ['read', 'img.view', 'img.hires', 'img.unlimited', 'review.submit', 'review.approve', 'feedback.manage', 'member.manage', 'admin.panel'];
// 普通读者（含匿名）看低清、少量书影：不含 img.hires／img.unlimited。
export const ROLE_PRESETS = {
  reader: ['read', 'img.view'],
  reviewer: ['read', 'img.view', 'review.submit'],
  editor: ['read', 'img.view', 'review.submit', 'review.approve', 'feedback.manage'],
  admin: CAPS,
};
export function effectiveCaps(member, now = Date.now()) {
  if (!member || member._deleted || !member.role) return [];
  const set = new Set(ROLE_PRESETS[member.role] || []);
  const caps = member.caps && typeof member.caps === 'object' ? member.caps : {};
  for (const [name, g] of Object.entries(caps)) {
    if (!CAPS.includes(name)) continue;
    if (g && g.revoked) { set.delete(name); continue; }
    if (g && Number.isFinite(g.exp) && g.exp < now) continue;
    set.add(name);
  }
  return [...set].sort();
}
export const hasCap = (member, cap, now) => effectiveCaps(member, now).includes(cap);
