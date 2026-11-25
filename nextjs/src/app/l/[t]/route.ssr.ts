// 登录邮件里的短链：https://域名/l/<token> → Better Auth 的魔法链接验证地址（腾讯邮件模板要求链接保留确定域名，所以邮件只带 token）。
import { baEnabled, siteOrigin } from '@/lib/server/ba-config.ssr';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ t: string }> }) {
  if (!baEnabled()) return new Response('Not Found', { status: 404 });
  const { t } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(t)) return Response.redirect(`${siteOrigin()}/register?error=expired`, 302);
  const to = `${siteOrigin()}/api/ba/magic-link/verify?${new URLSearchParams({ token: t, callbackURL: '/api/ba-session' })}`;
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
