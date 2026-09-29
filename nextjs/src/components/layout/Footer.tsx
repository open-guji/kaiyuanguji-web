import Link from 'next/link';
import { MORE_LINKS } from './nav-links';

// 站内栏：主干入口＋顶栏拿下来的入口（整理平台、路线图、小工具）。反馈归「关于与联系」栏，这里不重复。
const siteLinks = [
  { label: '古籍元数据', href: '/book-index' },
  { label: '古籍总目', href: '/catalog' },
  ...MORE_LINKS.filter((l) => l.href !== '/feedback'),
];

// 关于与联系（N6，overview#259）：反馈统一到站内 /feedback，不再外链腾讯问卷。
// 微信群二维码放在右侧（7 天过期，过期后换 public/images/wechat-group-qr.png）。
const aboutLinks = [
  { label: '关于我们', href: '/about' },
  { label: '联系我们', href: '/contact' },
  { label: '反馈与纠错', href: '/feedback' },
];

/**
 * 页脚：黑底、一行排开（用户意见，overview#267）。
 * 去掉了「开源古籍」标题与介绍（上面页面已经说过）和「开放协议」一栏（首页「文本开放、代码开源」里有）；
 * 站内链接、关于与联系、二维码横着并排，纵向越低越好；版权、隐私、备案压成最下面一行。
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="og-footer">
      <div className="og-footer-inner">
        <div className="og-footer-row">
          <nav aria-label="站内链接" className="og-footer-links">
            <h2>站内</h2>
            <ul>
              {siteLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="关于与联系" className="og-footer-links">
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

          <div className="og-footer-qr">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/wechat-group-qr.png" alt="微信群「开源古籍交流群」二维码" width={72} height={72} loading="lazy" />
            <p>
              开源古籍交流群
              <br />
              微信扫码加入
            </p>
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
