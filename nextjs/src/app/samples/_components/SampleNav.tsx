import Link from 'next/link';

// 新导航（按新稿，34 卡 §七·3）：首页｜古籍总目｜古籍索引｜阅读页｜关于。
// 删掉的现网入口（整理平台、路线图、小工具、反馈）已登记在 34 卡「删减登记」。
const LINKS = [
  { key: 'home', label: '首页', href: '/samples/home' },
  { key: 'catalog', label: '古籍总目', href: '#' },
  { key: 'index', label: '古籍索引', href: '/samples/item' },
  { key: 'reader', label: '阅读页', href: '/samples/reader' },
  { key: 'about', label: '关于', href: '/about' },
];

export default function SampleNav({ active, onHero = false }: { active: string; onHero?: boolean }) {
  return (
    <header className={`smp-nav${onHero ? ' on-hero' : ''}`}>
      <div className="smp-nav-inner">
        <Link href="/samples/home" className="smp-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/open-guji-logo.webp" alt="开源古籍 Logo" />
          <span>开源古籍</span>
        </Link>
        <nav className="smp-links" aria-label="主导航">
          {LINKS.map((l) => (
            <Link key={l.key} href={l.href} className={l.key === active ? 'active' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="smp-nav-right">
          {/* 繁简：文字切换，不做按钮 */}
          <span className="sc">
            <b>繁</b> / 简
          </span>
          <button className="smp-burger" aria-label="打开菜单">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
