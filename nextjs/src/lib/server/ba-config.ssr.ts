// Better Auth 开放注册的开关与环境变量（只在全栈构建里存在，静态导出不打包 *.ssr.ts）。
// 开关默认全关：BA_ENABLED 不为 "1" 时所有 /api/ba* 路由回 404，现有邀请制登录完全不受影响。
export function baEnabled(): boolean {
  return process.env.BA_ENABLED === '1';
}
/** 开放注册：关时只有「已是成员」的邮箱能收到登录链接（不暴露邮箱是否存在，一律回成功）。 */
export function registrationOpen(): boolean {
  return process.env.BA_REGISTRATION_OPEN === '1';
}
// 站点域名只从环境变量来（仓里不写死本站域名，见 ops/tests/hosts.test.mjs）；BETTER_AUTH_URL 必配。
export function siteOrigin(): string {
  return (process.env.BETTER_AUTH_URL || process.env.SITE_ORIGIN || '').replace(/\/+$/, '');
}
export function inboxBaseToken() {
  return {
    base: (process.env.WEB_INBOX_URL || 'https://data.open-guji.com').replace(/\/+$/, ''),
    token: process.env.WEB_INBOX_TOKEN || process.env.FEEDBACK_ADMIN_TOKEN || '',
  };
}
