/**
 * 截图页面清单。要加页面：往 PAGES 里追加一行即可。
 * 全是 GET 的公开页面，不点任何按钮（测试站和 www 都连正式 KV，不能写）。
 */
import { ANCHORS } from '../fixtures/anchors.ts';

export interface ShotPage {
    /** 文件名用的短名（只用 ASCII 与 -） */
    name: string;
    /** 图集里显示的中文标题 */
    title: string;
    path: string;
    /** 只截首屏（不整页）：阅读页整页有一万八千多像素高，没法看 */
    firstScreenOnly?: boolean;
}

export const PAGES: ShotPage[] = [
    { name: 'home', title: '首页', path: '/' },
    { name: 'catalog', title: '古籍总目（經部）', path: '/catalog' },
    { name: 'catalog-unclassified', title: '古籍总目·未分类', path: '/catalog?node=unclassified' },
    { name: 'search', title: '搜索：史記', path: `/book-index?q=${encodeURIComponent('史記')}` },
    { name: 'work-shiji', title: 'Work：史記', path: `/item/${ANCHORS.work.id}` },
    { name: 'book-chengjia', title: 'Book：程甲本', path: '/item/96kzkdm8e8' },
    { name: 'collection-juzhen', title: 'Collection：武英殿聚珍版叢書', path: '/item/8rlcsybg2hhf' },
    { name: 'entity-zhuxi', title: 'Entity：朱熹', path: '/item/hixhd2h9bgah' },
    { name: 'read-home', title: '阅读首页', path: '/read' },
    { name: 'read-collated', title: '阅读页·整理本（直齋書錄解題）', path: `/read/${ANCHORS.collated.id}`, firstScreenOnly: true },
    { name: 'read-fulltext', title: '阅读页·全文（詩序，有版本下拉框）', path: '/read/d59f2ew0ctmo', firstScreenOnly: true },
    { name: 'about', title: '关于', path: '/about' },
    { name: 'contact', title: '联系（并入关于页）', path: '/about#联系' },
    { name: 'privacy', title: '隐私', path: '/privacy' },
    { name: 'feedback', title: '反馈', path: '/feedback' },
    { name: 'not-found', title: '404：不存在的条目', path: '/item/nonexistent000' },
];
