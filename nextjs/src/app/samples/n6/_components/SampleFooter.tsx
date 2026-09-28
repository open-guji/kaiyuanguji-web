import Link from 'next/link';
import Image from 'next/image';
import { SITE_DESCRIPTION } from '@/lib/constants';
import { ABOUT_HREF, CONTACT_HREF } from './links';

/**
 * N6 样张页脚。和现网比：
 * - 「参与项目」一栏改成「关于与联系」：关于我们、联系我们、反馈、项目源码；
 * - 「反馈」不再放「站内」栏，也不再外链腾讯问卷，统一到站内 /feedback；
 * - 品牌栏下可选放一个二维码（方案待定，图待提供）；
 * - 底栏只留版权、隐私、内测说明、备案号（「关于」挪进上面一栏）。
 */
const siteLinks = [
  { label: '古籍索引', href: '/book-index' },
  { label: '古籍总目', href: '/catalog' },
  { label: '整理平台', href: '/assistant' },
  { label: '路线图', href: '/roadmap' },
  { label: '小工具', href: '/tools' },
];

export default function SampleFooter() {
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
            <div className="n6-foot-qr">
              <span className="n6-qr n6-qr-sm" role="img" aria-label="二维码占位">
                〔二维码图
                <br />
                待提供〕
              </span>
              <span>〔公众号名称待定〕
                <br />
                扫码关注项目进展
              </span>
            </div>
          </div>

          <nav aria-label="站内链接">
            <h2>站内</h2>
            <ul>
              {siteLinks.map((l) => (
                <li key={l.href}>
                  <Link href={l.href}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="关于与联系">
            <h2>关于与联系</h2>
            <ul>
              <li>
                <Link href={ABOUT_HREF}>关于我们</Link>
              </li>
              <li>
                <Link href={CONTACT_HREF}>联系我们</Link>
              </li>
              <li>
                <Link href="/feedback">反馈与纠错</Link>
              </li>
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
          <span>© {new Date().getFullYear()} 开源古籍项目组</span>
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
