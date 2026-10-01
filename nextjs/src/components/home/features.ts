/**
 * 首页「我们在做的事」。只有真正上线的标 live，其余一律「规划中」——
 * 不在首页承诺没做出来的东西。
 * 标题、说明、入口文字在字典 home.features.<id>（overview#337），组件里 t() 取。
 */
import type { SiteMessageKey } from '@/i18n/translate';

export interface HomeFeature {
  /** 字典 home.features 下的键，也作 React key */
  id: string;
  titleKey: SiteMessageKey;
  textKey: SiteMessageKey;
  live: boolean;
  /** 已上线的才有入口：卡片底部一行文字链接 */
  cta?: { labelKey: SiteMessageKey; href: string };
}

export const HOME_FEATURES: HomeFeature[] = [
  {
    id: 'metadata',
    titleKey: 'home.features.metadata.title',
    textKey: 'home.features.metadata.text',
    live: true,
    cta: { labelKey: 'home.features.metadata.cta', href: '/catalog' },
  },
  {
    id: 'resources',
    titleKey: 'home.features.resources.title',
    textKey: 'home.features.resources.text',
    live: true,
    // 设计稿这里有「看一个例子 →」，但首页已按用户意见（overview#267）去掉了「看一个例子」、
    // 改为搜索框下三个例子，两者冲突，先不放，待用户定（overview#286 评论）。
  },
  {
    id: 'imageText',
    titleKey: 'home.features.imageText.title',
    textKey: 'home.features.imageText.text',
    live: false,
  },
  {
    id: 'fullText',
    titleKey: 'home.features.fullText.title',
    textKey: 'home.features.fullText.text',
    live: false,
  },
  {
    id: 'proofread',
    titleKey: 'home.features.proofread.title',
    textKey: 'home.features.proofread.text',
    live: false,
  },
  {
    id: 'model',
    titleKey: 'home.features.model.title',
    textKey: 'home.features.model.text',
    live: false,
  },
];
