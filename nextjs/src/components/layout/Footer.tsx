'use client';

// 只被 LayoutWrapper（客户端组件）引用，本来就在客户端边界内；标 'use client' 才能用 useSiteT 取 alt 等属性文字
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { icpForHost } from '@/lib/site-hosts';
import { useSiteT } from '@/i18n/use-site-t';

// 用户 9-30 反馈（overview#322）：页脚左边只留这四项，「站内」一栏（古籍元数据、古籍总目、整理平台、路线图、小工具）删掉。
// 「联系我们」并进关于页（/contact 跳到 /about#联系）。
const links: { labelKey: 'footer.about' | 'footer.contact' | 'footer.feedback'; href: string }[] = [
  { labelKey: 'footer.about', href: '/about' },
  { labelKey: 'footer.contact', href: '/about#联系' },
  { labelKey: 'footer.feedback', href: '/feedback' },
];

// 右边只留 QQ 群号文字（二维码更新太麻烦，11-03 撤掉微信、QQ 两张二维码）。
const QQ_GROUP = '111362573';

/**
 * 分支页（首页、目录、元数据、阅读、关于）共用的页脚；具体条目页、阅读页不显示（LayoutWrapper hideFooter）。
 * 黑底；左栏是四项链接，紧接着版权、隐私、备案一行；右栏 QQ 群号文字。
 * 用户 10-01 反馈（overview#337 B2）：链接与备案行合成左栏、两者间距压小；二维码下方空白减小。
 */
export default function Footer() {
  const currentYear = new Date().getFullYear();
  const t = useSiteT();
  // 备案号按访问的域名显示（overview#275）：首帧按规范域名 openguji.com，挂载后按实际主机改
  const [icp, setIcp] = useState(() => icpForHost(null));
  useEffect(() => { setIcp(icpForHost(window.location.hostname)); }, []);

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
              <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hans" target="_blank" rel="noopener noreferrer">{t('footer.license')}</a>
              <Link href="/privacy">{t('footer.privacy')}</Link>
              <Link href="/beta">{t('footer.beta')}</Link>
              <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
                {icp}
              </a>
            </div>
          </div>

          <p className="og-footer-group">{t('footer.qqGroup', { qq: QQ_GROUP })}</p>
        </div>
      </div>
    </footer>
  );
}
