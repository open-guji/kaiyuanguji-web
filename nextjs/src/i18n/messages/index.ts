/**
 * 字典登记处。新区域：messages/ 下建文件、defineMessages，再在这里登记一行。
 */
import type { MessageSet } from './define';
import { nav } from './nav';
import { footer } from './footer';
import { home } from './home';
import { common } from './common';
import { about } from './about';
import { pages } from './pages';
import { feedback } from './feedback';
import { readHome } from './read-home';
import { bookIndex } from './book-index';
import { seo } from './seo';

export const NAMESPACES = {
    nav,
    footer,
    home,
    common,
    about,
    pages,
    feedback,
    readHome,
    bookIndex,
    seo,
} satisfies Record<string, MessageSet<unknown>>;

export type SiteMessages = { [K in keyof typeof NAMESPACES]: (typeof NAMESPACES)[K]['zh-Hant'] };
