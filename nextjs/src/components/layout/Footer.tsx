import Link from 'next/link';
import Image from 'next/image';
import { SITE_DESCRIPTION } from '../../lib/constants';
import { MORE_LINKS } from './nav-links';

// 站内栏：主干入口＋顶栏拿下来的入口（整理平台、路线图、小工具）。反馈归「关于与联系」栏，这里不重复。
const siteLinks = [
  { label: '古籍索引', href: '/book-index' },
  { label: '古籍总目', href: '/catalog' },
  ...MORE_LINKS.filter((l) => l.href !== '/feedback'),
];

// 关于与联系（N6，overview#259）：反馈统一到站内 /feedback，不再外链腾讯问卷。
// 品牌栏下放微信群二维码（7 天过期，过期后换 public/images/wechat-group-qr.png）。
const aboutLinks = [
  { label: '关于我们', href: '/about' },
  { label: '联系我们', href: '/contact' },
  { label: '反馈与纠错', href: '/feedback' },
];

/**
 * 页脚（N1 起）：浅一阶底色分组，不用粗线、竖线和分隔线。
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
            <div className="og-footer-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/wechat-group-qr.png" alt="微信群「开源古籍交流群」二维码" width={96} height={96} loading="lazy" />
              <p>
                开源古籍交流群
                <br />
                微信扫码加入
              </p>
            </div>
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

          <nav aria-label="关于与联系">
            <h2>关于与联系</h2>
            <ul>
              {aboutLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
              <li>
                <a href="https://github.com/open-guji" target="_blank" rel="noopener noreferrer">
                  项目源码
                </a>
              </li>
            </ul>
          </nav>

          <div>
            <h2>开放协议</h2>
            <p>文本以 CC0 公有领域发布</p>
            <p>代码以 Apache-2.0 开源</p>
          </div>
        </div>

        <div className="og-footer-bottom">
          <span>© {currentYear} 开源古籍项目组</span>
          <Link href="/privacy">隐私说明</Link>
          <Link href="/beta">内测说明</Link>
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
            冀ICP备2026013455号
          </a>
        </div>
      </div>
    </footer>
  );
}
