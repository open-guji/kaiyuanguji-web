import Link from 'next/link';

// 用户 9-30 反馈（overview#322）：页脚左边只留这四项，「站内」一栏（古籍元数据、古籍总目、整理平台、路线图、小工具）删掉。
// 「联系我们」并进关于页（/contact 跳到 /about#联系）。
const links = [
  { label: '关于我们', href: '/about' },
  { label: '联系我们', href: '/about#联系' },
  { label: '反馈与纠错', href: '/feedback' },
];

// 右边两张群二维码，各配一行说明；QQ 那张再加一行群号。
// 微信群二维码 7 天过期，过期后换 public/images/wechat-group-qr.png。
const QQ_GROUP = '111362573';
const groups = [
  { src: '/images/wechat-group-qr.png', alt: '微信群「开源古籍交流群」二维码', lines: ['微信扫码进群'] },
  { src: '/images/qq-group-qr.png', alt: 'QQ 群「开源古籍交流群」二维码', lines: ['QQ 扫码进群', `群号 ${QQ_GROUP}`] },
];

/**
 * 分支页（首页、目录、元数据、阅读、关于）共用的页脚；具体条目页、阅读页不显示（LayoutWrapper hideFooter）。
 * 黑底；左边四项链接，右边两张二维码（中间留足间距）；版权、隐私、备案压成最下面一行。
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="og-footer">
      <div className="og-footer-inner">
        <div className="og-footer-row">
          <nav aria-label="关于与联系" className="og-footer-links">
            <ul>
              {links.map((link) => (
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

          <div className="og-footer-qrs">
            {groups.map((g) => (
              <figure key={g.src} className="og-footer-qr">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.src} alt={g.alt} width={88} height={88} loading="lazy" />
                <figcaption>
                  {g.lines.map((l) => (
                    <span key={l}>{l}</span>
                  ))}
                </figcaption>
              </figure>
            ))}
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
