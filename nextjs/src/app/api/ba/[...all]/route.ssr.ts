import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/server/ba-auth.ssr';
import { baEnabled } from '@/lib/server/ba-config.ssr';

export const dynamic = 'force-dynamic';
const off = () => new Response('Not Found', { status: 404 });
export async function GET(req: Request) { return baEnabled() ? toNextJsHandler(getAuth()).GET(req) : off(); }
export async function POST(req: Request) { return baEnabled() ? toNextJsHandler(getAuth()).POST(req) : off(); }
