'use client';

// 「文本整理」各页与侧栏共用一份快照：同一次打开后台只取一次 /api/text-progress
import { useEffect, useState } from 'react';
import type { Snapshot } from './model';

export type Load =
  | { state: 'loading' }
  | { state: 'error'; error: string }
  | { state: 'ok'; snapshot: Snapshot | null; storedAt?: string };

let cache: Promise<Load> | null = null;

/** 测试用：清掉缓存，下一次重新取 */
export function resetTextProgressCache() {
  cache = null;
}

async function fetchSnapshot(): Promise<Load> {
  try {
    const r = await fetch('/api/text-progress', { credentials: 'include', cache: 'no-store' });
    let j: { success?: boolean; error?: string; snapshot?: Snapshot | null; stored_at?: string };
    try { j = await r.json(); } catch { throw new Error(`HTTP ${r.status}`); }
    if (!j.success) throw new Error(j.error || `HTTP ${r.status}`);
    return { state: 'ok', snapshot: j.snapshot ?? null, storedAt: j.stored_at };
  } catch (e) {
    return { state: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

export function useTextProgress(): Load {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    if (!cache) cache = fetchSnapshot();
    cache.then((l) => {
      if (l.state === 'error') cache = null; // 失败的不缓存，换页再试
      if (alive) setLoad(l);
    });
    return () => { alive = false; };
  }, []);
  return load;
}
