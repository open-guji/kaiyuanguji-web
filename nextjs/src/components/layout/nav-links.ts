/**
 * 全站外壳的导航清单（N1，照样张）。
 *
 * 顶栏按新稿只留主干入口。样张里的「古籍总目」「阅读页」要等 N3 / N5
 * 的页面上线后再加，不先挂空链接。从顶栏拿下来的现网入口（整理平台、
 * 路线图、小工具、反馈）仍然有效，改放手机抽屉的「更多」和页脚，
 * 保证每个页面都还能点进去。
 *
 * 注意：sitemap 读的是 lib/constants 的 NAV_ITEMS，与这里无关，不要合并。
 */
export interface ShellLink {
  label: string;
  href: string;
}

export const PRIMARY_LINKS: ShellLink[] = [
  { label: '首页', href: '/' },
  { label: '古籍索引', href: '/book-index' },
  { label: '关于', href: '/about' },
];

export const MORE_LINKS: ShellLink[] = [
  { label: '整理平台', href: '/assistant' },
  { label: '路线图', href: '/roadmap' },
  { label: '小工具', href: '/tools' },
  { label: '反馈', href: '/feedback' },
];

/** 手机抽屉的 id：汉堡按钮 aria-controls 指向它 */
export const MOBILE_DRAWER_ID = 'og-mobile-drawer';

/** 正文容器的 id：「跳到正文」链接指向它 */
export const MAIN_CONTENT_ID = 'main-content';

/** 当前路由是否落在某个入口下（首页只精确匹配） */
export function isCurrent(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
