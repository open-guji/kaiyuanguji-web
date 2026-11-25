// Better Auth：只负责「验证邮箱」（魔法链接）与限频；验证后由 /api/ba-session 桥接成现有 session cookie。
// 数据库＝认证库 D1（openguji-auth），经 Worker 网关 /v1/auth/d1（d1-http）；会话 cookieCache，且桥接后立刻注销 BA 自己的会话，之后不再查库。
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { d1Http } from './d1-http.ssr';
import { registrationOpen, siteOrigin } from './ba-config.ssr';
import { readMember, decideMember } from './ba-members.ssr';
import { sendLoginMail } from './ba-mail.ssr';

let cached: ReturnType<typeof create> | null = null;
function create() {
  return betterAuth({
    baseURL: siteOrigin(),
    basePath: '/api/ba',
    secret: process.env.BETTER_AUTH_SECRET,
    // 认证库 openguji-auth，经 Worker 网关（BA_AUTH_URL 默认同收件箱的 WEB_INBOX_URL；BA_AUTH_TOKEN 是 Worker 的 auth 角色令牌）
    database: d1Http({
      base: process.env.BA_AUTH_URL || process.env.WEB_INBOX_URL || '',
      token: process.env.BA_AUTH_TOKEN || '',
    }) as never,
    session: { expiresIn: 60 * 60, updateAge: 60 * 60, cookieCache: { enabled: true, maxAge: 5 * 60 } },
    // 限频按客户端 IP 分桶；EdgeOne 把真实 IP 放在这些头里（不配会全站共用一个桶）
    advanced: { ipAddress: { ipAddressHeaders: ['eo-connecting-ip', 'x-forwarded-for', 'x-real-ip'] } },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 20,
      customRules: { '/sign-in/magic-link': { window: 600, max: 3 } },
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        sendMagicLink: async ({ email, url }) => {
          // 不暴露邮箱是否存在：不该发的一律静默返回
          const d = decideMember(await readMember(email.toLowerCase()), registrationOpen());
          if (d.action === 'blocked') return;
          await sendLoginMail(email, url);
        },
      }),
    ],
  });
}
export function getAuth() { return (cached ??= create()); }
