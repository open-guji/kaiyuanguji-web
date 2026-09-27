'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

const POLL_INTERVAL_MS = 3000;

// return_to 只信「指回本站 /oauth/authorize 的相对路径」——它来自 authorize 边缘函数
// 自己拼的原始请求 search，不是这里凭空信任的外部输入；仍要在这一端再校验一次，
// 防止有人拿这页当开放重定向跳板（例如分享 /oauth/login-required?return_to=https://evil.com）。
function safeReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  return raw.startsWith('/oauth/authorize?') ? raw : null;
}

export default function LoginRequiredClient() {
  const sp = useSearchParams();
  const returnTo = safeReturnTo(sp.get('return_to'));
  const [checking, setChecking] = useState(Boolean(returnTo));

  const tryContinue = useCallback(async () => {
    if (!returnTo) return false;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const j = await res.json().catch(() => null);
      if (res.ok && j && j.success) {
        window.location.href = returnTo;
        return true;
      }
    } catch {
      // 网络问题：忽略，等下一轮轮询
    }
    return false;
  }, [returnTo]);

  useEffect(() => {
    if (!returnTo) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    (async () => {
      const done = await tryContinue();
      if (stopped) return;
      setChecking(false);
      if (!done) {
        timer = setInterval(() => { tryContinue(); }, POLL_INTERVAL_MS);
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [returnTo, tryContinue]);

  return (
    <div className="max-w-xl mx-auto p-8 text-center">
      <h1 className="text-2xl font-bold mb-4">请先用邀请链接登录</h1>
      <p className="mb-2 text-gray-700">这个操作需要先登录开源古籍网站。</p>
      <p className="mb-4 text-gray-700">请在浏览器里打开你的邀请链接完成登录，登录后回到本页会自动继续；也可以手动点击下面的按钮。</p>
      {checking && <p className="text-sm text-gray-400 mb-4">正在检测登录状态…</p>}
      {returnTo && (
        <button
          onClick={() => { window.location.href = returnTo; }}
          className="bg-black text-white rounded px-4 py-2"
        >
          已登录，继续
        </button>
      )}
    </div>
  );
}
