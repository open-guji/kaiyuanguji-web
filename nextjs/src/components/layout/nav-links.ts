/**
 * 全站外壳的导航清单（N1，照样张）。
 *
 * 顶栏只留主干入口：首页｜目录｜元数据｜阅读｜关于（用户 9-30 反馈改短，overview#322）。
 * 「阅读」（/read）是阅读首页，列出有整理本或全文的书（overview#267 第 16 项）。
 * 「古籍元数据」（/book-index，搜索入口）原名「古籍索引」，用户意见改名（overview#267）。
 * 「古籍总目」（/catalog）由 WEB2（overview#249）加上，页面归 N4b，可能晚于本项合入。
 * 单本的阅读页（/read/<id>）仍从条目页的「阅读全文」进去。从顶栏拿下来的现网入口（整理平台、
 * 路线图、小工具、反馈）仍然有效，放在手机抽屉的「更多」里（页脚按 9-30 反馈不再列它们）。
 *
 * 注意：sitemap 读的是 lib/constants 的 NAV_ITEMS，与这里无关，不要合并。
 * 文字存字典键（nav.links.*），组件里 t(labelKey) 取，跟随繁简偏好（overview#337）。
 */
import type { SiteMessageKey } from '@/i18n/translate';

export interface ShellLink {
  labelKey: SiteMessageKey;
  href: string;
}

export const PRIMARY_LINKS: ShellLink[] = [
  { labelKey: 'nav.links.home', href: '/' },
  { labelKey: 'nav.links.catalog', href: '/catalog' },
  { labelKey: 'nav.links.bookIndex', href: '/book-index' },
  { labelKey: 'nav.links.read', href: '/read' },
  { labelKey: 'nav.links.about', href: '/about' },
];

export const MORE_LINKS: ShellLink[] = [
  { labelKey: 'nav.links.assistant', href: '/assistant' },
  { labelKey: 'nav.links.roadmap', href: '/roadmap' },
  { labelKey: 'nav.links.tools', href: '/tools' },
  { labelKey: 'nav.links.feedback', href: '/feedback' },
];

/** 手机抽屉的 id：汉堡按钮 aria-controls 指向它 */
export const MOBILE_DRAWER_ID = 'og-mobile-drawer';

/** 正文容器的 id：「跳到正文」链接指向它 */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * 不在入口路径下、但归属某个入口的路由：条目页 /item/<id> 属「元数据」（用户 10-01 反馈，overview#337 B6）。
 */
const CURRENT_ALIASES: Record<string, string[]> = {
  '/book-index': ['/item'],
};

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** 当前路由是否落在某个入口下（首页只精确匹配） */
export function isCurrent(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === '/') return pathname === '/';
  return under(pathname, href) || (CURRENT_ALIASES[href] ?? []).some((a) => under(pathname, a));
}
