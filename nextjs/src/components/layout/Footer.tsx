import Link from 'next/link';
import Image from 'next/image';
import { SITE_DESCRIPTION } from '../../lib/constants';
import { MORE_LINKS } from './nav-links';

const siteLinks = [{ label: '古籍索引', href: '/book-index' }, ...MORE_LINKS];

const externalLinks = [
  { label: '项目源码', url: 'https://github.com/open-guji' },
  { label: '问题反馈', url: 'https://wj.qq.com/s2/25492820/38ce/' },
];

/**
 * 页脚（N1）：浅一阶底色分组，不用粗线、竖线和分隔线。
 * 顶栏拿下来的入口（整理平台、路线图、小工具、反馈）在这里保留。
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="og-footer">
      <div className="og-footer-inner">
        <div className="og-footer-grid">
          <div>
            <div className="og-footer-brand">
              <Image src="/images/open-guji-logo.webp" alt="" width={24} height={24} />
              开源古籍
            </div>
            <p>{SITE_DESCRIPTION}</p>
          </div>

          <nav aria-label="站内链接">
            <h2>站内</h2>
            <ul>
              {siteLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <h2>参与项目</h2>
            <ul>
              {externalLinks.map((link) => (
                <li key={link.label}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2>开放协议</h2>
            <p>文本以 CC0 公有领域发布</p>
            <p>代码以 Apache-2.0 开源</p>
          </div>
        </div>

        <div className="og-footer-bottom">
          <span>© {currentYear} 开源古籍项目组</span>
          <Link href="/about">关于</Link>
          <Link href="/beta">内测说明</Link>
          <Link href="/privacy">隐私说明</Link>
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
            冀ICP备2026013455号
          </a>
        </div>
      </div>
    </footer>
  );
}
