// 魔法链接验证成功后的落点：把 Better Auth 的会话换成现有的 session JWT cookie（成员体系不变）。
import { getAuth } from '@/lib/server/ba-auth.ssr';
import { baEnabled, registrationOpen, siteOrigin } from '@/lib/server/ba-config.ssr';
import { cleanNickname, decideMember, nextMember, readMember, safeNext, sessionCookie, signSession, writeMember } from '@/lib/server/ba-members.ssr';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!baEnabled()) return new Response('Not Found', { status: 404 });
  const url = new URL(req.url);
  const origin = siteOrigin();
  const to = (path: string, headers?: Headers) => {
    const h = headers || new Headers();
    h.set('Location', origin + path);
    return new Response(null, { status: 302, headers: h });
  };
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) return to('/register?error=config');
  try {
    const auth = getAuth();
    const s = await auth.api.getSession({ headers: req.headers });
    const email = s?.user?.email?.toLowerCase();
    if (!email) return to('/register?error=expired');
    const existing = await readMember(email);
    const d = decideMember(existing, registrationOpen());
    if (d.action === 'blocked') return to('/register?error=blocked');
    const member = nextMember(existing, Math.floor(Date.now() / 1000), cleanNickname(url.searchParams.get('nick')));
    await writeMember(email, member);
    const token = await signSession(email, member.tokenVersion as number, secret);
    const h = new Headers();
    h.append('Set-Cookie', sessionCookie(token));
    // 桥接完成：注销 BA 自己的会话（清它的 cookie），之后不再查库
    try {
      const out = await auth.api.signOut({ headers: req.headers, returnHeaders: true });
      out.headers.getSetCookie().forEach((c) => h.append('Set-Cookie', c));
    } catch { /* 注销失败不影响登录 */ }
    return to(safeNext(url.searchParams.get('next')), h);
  } catch (e) {
    console.error('ba-session', e);
    return to('/register?error=server');
  }
}
