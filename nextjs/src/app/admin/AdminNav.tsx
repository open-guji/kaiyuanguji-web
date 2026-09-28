'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/admin', label: '总览' },
  { href: '/admin/members', label: '成员' },
  { href: '/admin/invites', label: '邀请' },
  { href: '/admin/errors', label: '错误日志' },
  { href: '/admin/feedback', label: '反馈' },
  { href: '/admin/servers', label: '服务器' },
  { href: '/admin/traffic', label: '流量' },
];

export default function AdminNav() {
  const path = usePathname();
  return (
    <nav className="w-40 shrink-0">
      <ul className="space-y-1 sticky top-16">
        {items.map(it => {
          const active = path === it.href;
          return (
            <li key={it.href}>
              <Link href={it.href} className={`block px-3 py-1.5 rounded text-sm ${active ? 'bg-black text-white' : 'text-gray-700 hover:bg-gray-100'}`}>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
