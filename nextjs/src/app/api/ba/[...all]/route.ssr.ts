import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/server/ba-auth.ssr';
import { baEnabled } from '@/lib/server/ba-config.ssr';

export const dynamic = 'force-dynamic';
const off = () => new Response('Not Found', { status: 404 });
// 出错时回 JSON（只含错误信息，不含密钥），不要让边缘平台回空 500，方便定位。
async function run(method: 'GET' | 'POST', req: Request) {
  if (!baEnabled()) return off();
  try {
    return await toNextJsHandler(getAuth())[method](req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[ba] handler error', msg);
    return Response.json({ error: 'ba_failed', message: msg.slice(0, 300) }, { status: 500 });
  }
}
export async function GET(req: Request) { return run('GET', req); }
export async function POST(req: Request) { return run('POST', req); }
