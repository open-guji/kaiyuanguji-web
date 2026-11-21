// 试验：Better Auth 在 EdgeOne Node 函数（Next standalone）里跑，数据库用 Cloudflare D1（HTTP）。不进正式站。
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { d1Http } from './d1-http.ssr';

export const auth = betterAuth({
  basePath: '/api/ba',
  secret: process.env.BETTER_AUTH_SECRET || 'experiment-only-secret-change-me-0123456789',
  // 对外像 D1 绑定的 HTTP 适配，Better Auth 按 D1 处理（无交互事务，用 batch）
  database: d1Http({
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    databaseId: process.env.CF_D1_DATABASE_ID || '',
    apiToken: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
  }) as never,
  session: {
    expiresIn: 60 * 60 * 24 * 180,
    updateAge: 60 * 60 * 24,
    // 会话短时间放进签名 cookie 验证，少查 D1（Cloudflare HTTP 接口按账号限速）
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        console.log('[ba-experiment] magic link for', email, url); // 试验：只打日志，不发信
      },
    }),
  ],
});
