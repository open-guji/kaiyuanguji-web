import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/server/ba-auth.ssr';

export const dynamic = 'force-dynamic';
export const { GET, POST } = toNextJsHandler(auth);
