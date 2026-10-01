import { TOOL_PAGES } from '@/lib/constants';
import { getSiteT } from '@/i18n';
import { TOOL_GROUP_KEY, toolIntentKey, toolTitleKey } from '../tool-i18n';

// TOOL_PAGES 新增或改字时，字典 pages.tools.items 要同步（简体栏与常量逐字一致）
describe('小工具字典与 TOOL_PAGES 同步', () => {
  const t = getSiteT('zh-Hans');
  for (const tool of TOOL_PAGES) {
    it(tool.slug, () => {
      expect(t(toolTitleKey(tool))).toBe(tool.title);
      expect(t(toolIntentKey(tool))).toBe(tool.intent);
      expect(t(TOOL_GROUP_KEY[tool.group])).toBe(tool.group);
    });
  }
});
