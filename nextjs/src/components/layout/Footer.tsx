'use client';

// 只被 LayoutWrapper（客户端组件）引用，本来就在客户端边界内；标 'use client' 才能用 useSiteT 取 alt 等属性文字
import Link from 'next/link';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteMessageKey } from '@/i18n/translate';

// 用户 9-30 反馈（overview#322）：页脚左边只留这四项，「站内」一栏（古籍元数据、古籍总目、整理平台、路线图、小工具）删掉。
// 「联系我们」并进关于页（/contact 跳到 /about#联系）。
const links: { labelKey: SiteMessageKey; href: string }[] = [
  { labelKey: 'footer.about', href: '/about' },
  { labelKey: 'footer.contact', href: '/about#联系' },
  { labelKey: 'footer.feedback', href: '/feedback' },
];

// 右边两张群二维码，各配一行说明；QQ 那张再加一行群号。
// 微信群二维码 7 天过期，过期后换 public/images/wechat-group-qr.png。
const QQ_GROUP = '111362573';
const groups: { src: string; altKey: SiteMessageKey; lineKeys: SiteMessageKey[] }[] = [
  { src: '/images/wechat-group-qr.png', altKey: 'footer.wechatAlt', lineKeys: ['footer.wechatScan'] },
  { src: '/images/qq-group-qr.png', altKey: 'footer.qqAlt', lineKeys: ['footer.qqScan', 'footer.qqNumber'] },
];

/**
 * 分支页（首页、目录、元数据、阅读、关于）共用的页脚；具体条目页、阅读页不显示（LayoutWrapper hideFooter）。
 * 黑底；左栏是四项链接，紧接着版权、隐私、备案一行；右栏两张二维码（中间留足间距）。
 * 用户 10-01 反馈（overview#337 B2）：链接与备案行合成左栏、两者间距压小；二维码下方空白减小。
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();
  const t = useSiteT();

  return (
    <footer className="og-footer">
      <div className="og-footer-inner">
        <div className="og-footer-row">
          <div className="og-footer-main">
            <nav aria-label={t('footer.navLabel')} className="og-footer-links">
              <ul>
                {links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{t(link.labelKey)}</Link>
                  </li>
                ))}
                <li>
                  <a href="https://github.com/open-guji" target="_blank" rel="noopener noreferrer">
                    {t('footer.source')}
                  </a>
                </li>
              </ul>
            </nav>

            <div className="og-footer-bottom">
              <span>{t('footer.copyright', { year: currentYear })}</span>
              <Link href="/privacy">{t('footer.privacy')}</Link>
              <Link href="/beta">{t('footer.beta')}</Link>
              <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
                冀ICP备2026013455号
              </a>
            </div>
          </div>

          <div className="og-footer-qrs">
            {groups.map((g) => (
              <figure key={g.src} className="og-footer-qr">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={g.src} alt={t(g.altKey)} width={88} height={88} loading="lazy" />
                <figcaption>
                  {g.lineKeys.map((k) => (
                    <span key={k}>{t(k, { qq: QQ_GROUP })}</span>
                  ))}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
