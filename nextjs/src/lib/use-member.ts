'use client';

import { useCallback, useEffect, useState } from 'react';

export interface MemberInfo { email: string; role: string; joinedAt?: number; nickname?: string }
export type MemberState = { status: 'loading' } | { status: 'anon' } | { status: 'member'; member: MemberInfo };

let cache: MemberState | null = null;
const listeners = new Set<(s: MemberState) => void>();
let inflight: Promise<void> | null = null;

/** 仅测试用：清掉缓存。 */
export function __resetMemberCache() { cache = null; inflight = null; }

function publish(s: MemberState) {
  cache = s;
  listeners.forEach((fn) => fn(s));
}

function load(): Promise<void> {
  if (typeof fetch === 'undefined') { publish({ status: 'anon' }); return Promise.resolve(); }
  inflight ??= fetch('/api/auth/me', { cache: 'no-store', credentials: 'include' })
    .then(async (r) => {
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j?.success && j.email) publish({ status: 'member', member: { email: j.email, role: j.role, joinedAt: j.joinedAt, nickname: j.nickname || undefined } });
      else publish({ status: 'anon' });
    })
    .catch(() => publish({ status: 'anon' }))
    .finally(() => { inflight = null; });
  return inflight;
}

/** 当前登录身份（顶栏、用户页共用，同一页面只请求一次 /api/auth/me）。 */
export function useMember() {
  const [state, setState] = useState<MemberState>(cache ?? { status: 'loading' });
  useEffect(() => {
    listeners.add(setState);
    if (cache) setState(cache); else void load();
    return () => { listeners.delete(setState); };
  }, []);
  const logout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch { /* 清不掉就让它过期 */ }
    publish({ status: 'anon' });
  }, []);
  /** 设置或清除昵称（空串＝清除）。成功返回 { ok: true }，失败带服务端给的原因。 */
  const setNickname = useCallback(async (nickname: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const r = await fetch('/api/auth/nickname', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.success) return { ok: false, error: (j && j.error) || '保存失败' };
      if (cache && cache.status === 'member') publish({ status: 'member', member: { ...cache.member, nickname: j.nickname || undefined } });
      return { ok: true };
    } catch { return { ok: false, error: '网络不通，请稍后再试' }; }
  }, []);
  return { state, logout, setNickname };
}
