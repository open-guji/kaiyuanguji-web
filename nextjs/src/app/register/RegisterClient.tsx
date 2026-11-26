'use client';

import { useSearchParams } from 'next/navigation';
import LoginForm from '@/components/auth/LoginForm';

const ERRORS: Record<string, string> = {
  expired: '登录链接已失效或已使用，请重新获取。',
  blocked: '这个邮箱暂时不能登录，请联系管理员。',
  config: '登录服务暂未配置好，请稍后再试。',
  server: '登录服务暂时出错，请稍后再试。',
};

export default function RegisterClient() {
  const sp = useSearchParams();
  const err = sp.get('error');
  return (
    <div className="og-account">
      <h1>登录／注册</h1>
      {err && ERRORS[err] && <p className="og-login-err">{ERRORS[err]}</p>}
      <LoginForm next={sp.get('next')} />
    </div>
  );
}
