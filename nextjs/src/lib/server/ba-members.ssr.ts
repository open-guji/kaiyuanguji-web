// Better Auth ↔ 现有成员体系的桥：成员记录仍在中心库 web_inbox（kind=kv，键 member:<邮箱>），
// 会话仍是现有的 HS256 JWT cookie（session），所以 /api/auth/me、/admin、/oauth 都不用改，老成员邮箱相同即「平移」。
import { inboxBaseToken } from './ba-config.ssr';

export const COOKIE_MAX_AGE = 180 * 24 * 3600;
export type Member = { role: string; joinedAt?: number; invitedBy?: string; tokenVersion?: number; verified?: boolean; _deleted?: boolean };

// 与边缘函数 d1Kv 的键编码一致（feedback.js kvEnc）
const kvEnc = (k: string) => k.replace(/[^A-Za-z0-9:_.|-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, '0')}~`);
export const memberKey = (email: string) => kvEnc(`member:${email}`);

async function inboxFetch(path: string, init?: RequestInit) {
  const { base, token } = inboxBaseToken();
  if (!token) throw new Error('D1 收件箱没有令牌');
  const res = await fetch(`${base}/v1/web/inbox${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
    cache: 'no-store',
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`D1 收件箱 HTTP ${res.status}`);
  return res.json();
}

export async function readMember(email: string): Promise<Member | null> {
  const key = memberKey(email);
  const page = await inboxFetch(`?${new URLSearchParams({ kind: 'kv', prefix: key, limit: '20' })}`);
  const row = (page.items || []).find((r: { key: string }) => r.key === key);
  if (!row || !row.value || typeof row.value.s !== 'string') return null;
  if (row.value.exp && row.value.exp < Date.now()) return null;
  try { return JSON.parse(row.value.s) as Member; } catch { return null; }
}
export async function writeMember(email: string, m: Member): Promise<void> {
  await inboxFetch('', { method: 'POST', body: JSON.stringify({ items: [{ kind: 'kv', key: memberKey(email), value: { s: JSON.stringify(m) } }] }) });
}

/** 已存在且未被移除＝活成员；被管理员移除（墓碑）的邮箱不允许自助注册回来，要管理员重新邀请。 */
export type Decision = { action: 'login' | 'register' | 'blocked'; member?: Member };
export function decideMember(existing: Member | null, registrationIsOpen: boolean): Decision {
  if (existing && existing._deleted) return { action: 'blocked' };
  if (existing && existing.role) return { action: 'login', member: existing };
  if (!registrationIsOpen) return { action: 'blocked' };
  return { action: 'register' };
}

/** 邮箱经 Better Auth 验证后更新成员记录：保留角色与 tokenVersion（不踢其他设备），标 verified。新注册默认 reader。 */
export function nextMember(existing: Member | null, now: number): Member {
  if (existing && existing.role && !existing._deleted) {
    const tv = Number.isInteger(existing.tokenVersion) && (existing.tokenVersion as number) > 0 ? (existing.tokenVersion as number) : 1;
    return { ...existing, tokenVersion: tv, verified: true };
  }
  return { role: 'reader', joinedAt: now, invitedBy: 'self-register', tokenVersion: 1, verified: true };
}

import { createHmac } from 'node:crypto';
const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
export async function signSession(email: string, tokenVersion: number, secret: string, now = Math.floor(Date.now() / 1000)) {
  const part = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));
  const data = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: email, iat: now, exp: now + COOKIE_MAX_AGE, tv: tokenVersion })}`;
  return `${data}.${b64url(createHmac('sha256', secret).update(data).digest())}`;
}
export const sessionCookie = (token: string) => `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
/** next 只收站内相对路径，防开放重定向 */
export function safeNext(raw: string | null): string {
  return raw && /^\/(?!\/)[^\\\r\n]*$/.test(raw) ? raw : '/';
}
