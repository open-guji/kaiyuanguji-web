// Better Auth：只负责「验证邮箱」（魔法链接）与限频；验证后由 /api/ba-session 桥接成现有 session cookie。
// 数据库＝中心库 D1，经 REST（d1-http）；防 REST 限速：会话 cookieCache，且桥接后立刻注销 BA 自己的会话，之后不再查库。
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
    database: d1Http({
      // 认证单独一个 D1（guji-auth），令牌只授权这一个库，不用中心库的令牌
      accountId: process.env.BA_CF_ACCOUNT_ID || '',
      databaseId: process.env.BA_D1_DATABASE_ID || '',
      apiToken: process.env.BA_D1_API_TOKEN || '',
    }) as never,
    session: { expiresIn: 60 * 60, updateAge: 60 * 60, cookieCache: { enabled: true, maxAge: 5 * 60 } },
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
