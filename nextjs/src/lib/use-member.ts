'use client';

import { useCallback, useEffect, useState } from 'react';

export interface MemberInfo { email: string; role: string; joinedAt?: number }
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
      if (r.status === 200 && j?.success && j.email) publish({ status: 'member', member: { email: j.email, role: j.role, joinedAt: j.joinedAt } });
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
  return { state, logout };
}
