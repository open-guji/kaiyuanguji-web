import type { ToolPageInfo } from '@/lib/constants';
import type { SiteMessageKey } from '@/i18n';

/**
 * 小工具的界面文字键（overview#337）。lib/constants 的 TOOL_PAGES 仍保留简体原文（generateMetadata、站点地图用），
 * 页面上显示的名称、用途走字典 pages.tools.items.<slug>.*，跟随繁简偏好；两边一致由 __tests__/tool-i18n.test.ts 守着。
 */
export const TOOL_GROUP_KEY = {
  词典: 'pages.tools.groups.dict',
  韵书: 'pages.tools.groups.rhyme',
} as const satisfies Record<ToolPageInfo['group'], SiteMessageKey>;

export const toolTitleKey = (tool: ToolPageInfo) => `pages.tools.items.${tool.slug}.title` as SiteMessageKey;
export const toolIntentKey = (tool: ToolPageInfo) => `pages.tools.items.${tool.slug}.intent` as SiteMessageKey;
