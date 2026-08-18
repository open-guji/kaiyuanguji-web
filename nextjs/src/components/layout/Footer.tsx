import Link from 'next/link';
import { SITE_DESCRIPTION } from '../../lib/constants';

const siteLinks = [
  { label: '古籍索引', href: '/book-index' },
  { label: '整理平台', href: '/assistant' },
  { label: '路线图', href: '/roadmap' },
  { label: '反馈', href: '/feedback' },
];

const externalLinks = [
  { label: '项目源码', url: 'https://github.com/open-guji' },
  { label: '问题反馈', url: 'https://wj.qq.com/s2/25492820/38ce/' },
];

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="mt-20 border-t-[3px] border-[var(--color-vermilion)] bg-[#16120f] text-white/80">
      <div className="mx-auto max-w-7xl px-6 pb-8 pt-14">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {/* 关于 */}
          <div>
            <h4 className="mb-4 border-l-[3px] border-[var(--color-vermilion)] pl-2.5 text-base text-white">
              开源古籍
            </h4>
            <p className="text-sm leading-relaxed text-white/60">{SITE_DESCRIPTION}</p>
          </div>

          {/* 站内导航 */}
          <div>
            <h4 className="mb-4 border-l-[3px] border-[var(--color-vermilion)] pl-2.5 text-base text-white">
              快速链接
            </h4>
            <ul className="m-0 list-none p-0">
              {siteLinks.map((link) => (
                <li key={link.href} className="mb-2.5">
                  <Link
                    href={link.href}
                    className="text-sm text-white/70 no-underline transition-colors hover:text-white hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* 参与项目 */}
          <div>
            <h4 className="mb-4 border-l-[3px] border-[var(--color-vermilion)] pl-2.5 text-base text-white">
              参与项目
            </h4>
            <ul className="m-0 list-none p-0">
              {externalLinks.map((link) => (
                <li key={link.label} className="mb-2.5">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-white/70 no-underline transition-colors hover:text-white hover:underline"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* 开源协议 */}
          <div>
            <h4 className="mb-4 border-l-[3px] border-[var(--color-vermilion)] pl-2.5 text-base text-white">
              开源协议
            </h4>
            <p className="text-sm font-bold text-white/80">基于 Apache-2.0 协议发布</p>
            <p className="mt-1.5 text-sm leading-relaxed text-white/50">
              推动古籍数字化、校对及开源存储
            </p>
          </div>
        </div>

        {/* 底栏 */}
        <div className="mt-12 flex flex-col items-center gap-2 border-t border-white/10 pt-6 text-center">
          <p className="text-sm text-white/50">
            © {currentYear} 开源古籍项目组 · Powered by Next.js
          </p>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-white/30 no-underline transition-colors hover:text-white/60"
          >
            冀ICP备2026013455号
          </a>
        </div>
      </div>
    </footer>
  );
}
