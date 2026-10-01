'use client';

import Link from 'next/link';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteMessageKey } from '@/i18n/translate';

// 「文本开放、代码开源」两栏（用户意见，overview#267）。仓库地址与说明已对照各仓 README 核实：
// book-index 只存元数据，book-text 存古籍文本（CC0）；luatex-cn、bookget-py 为 Apache-2.0。
// 从 app/page.tsx 原样搬出（overview#337）：区块 aria-label、许可徽标的 aria-label 要跟繁简偏好，
// 服务端组件里的属性用不了 <T>，只好整块做成客户端组件；标记与样式不变。
const GITHUB = 'https://github.com/open-guji';
const OPEN_TEXT_REPOS: { name: string; noteKey: SiteMessageKey }[] = [
  { name: 'book-text', noteKey: 'home.open.repos.bookText' },
  { name: 'book-index', noteKey: 'home.open.repos.bookIndex' },
];
const OPEN_CODE_REPOS: { name: string; noteKey: SiteMessageKey }[] = [
  { name: 'luatex-cn', noteKey: 'home.open.repos.luatexCn' },
  { name: 'bookget-py', noteKey: 'home.open.repos.bookgetPy' },
];

export default function HomeOpen() {
  const t = useSiteT();
  return (
    <section className="home-open" aria-label={t('home.open.label')}>
      <div className="home-open-inner">
        <div className="home-open-col">
          <div className="home-open-head"><span className="home-badge" aria-label={t('home.open.textBadge')}>CC0</span><h2>{t('home.open.textTitle')}</h2></div>
          <p className="home-open-sub">{t('home.open.textSub')}</p>
          <ul className="home-repos">
            {OPEN_TEXT_REPOS.map((r) => (
              <li key={r.name}>
                <a href={`${GITHUB}/${r.name}`} target="_blank" rel="noopener noreferrer">
                  {r.name}<span className="home-repo-arrow" aria-hidden="true"> ↗</span>
                </a>
                <span>{t(r.noteKey)}</span>
              </li>
            ))}
          </ul>
          <p className="home-open-note">
            {t('home.open.textNoteBefore')}
            <Link href="/about">{t('home.open.textNoteLink')}</Link>{t('home.open.textNoteAfter')}
          </p>
        </div>
        <div className="home-open-col">
          <div className="home-open-head"><span className="home-badge" aria-label={t('home.open.codeBadge')}>Apache-2.0</span><h2>{t('home.open.codeTitle')}</h2></div>
          <p className="home-open-sub">
            {t('home.open.codeSub')}<a href={GITHUB} target="_blank" rel="noopener noreferrer">{t('home.open.codeAll')}</a>
          </p>
          <ul className="home-repos">
            {OPEN_CODE_REPOS.map((r) => (
              <li key={r.name}>
                <a href={`${GITHUB}/${r.name}`} target="_blank" rel="noopener noreferrer">
                  {r.name}<span className="home-repo-arrow" aria-hidden="true"> ↗</span>
                </a>
                <span>{t(r.noteKey)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
