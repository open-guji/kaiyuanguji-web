/**
 * 新旧架构对比（任务书 §六）：同一组页面同时打旧站（静态导出，www）与新站（全栈，ssr-test）。
 * 新站还没上线：它的失败只记录进样本，不开告警 issue。
 *
 * 可用 MON_COMPARE_TARGETS（JSON，同下面的形状）整体覆盖；MON_COMPARE_NEW 只换新站地址。
 */

// 10 个条目：热门 4 个（锚点／perf 场景里已有，perf-ids 契约盯着不烂）＋冷门 6 个（e2e 空状态候选池，几乎没人访问，CDN 多半没缓存）
export const COMPARE_IDS = [
  { id: 'd59f20aowb9c', note: '史記（作品，热）' },
  { id: 'hixhd2h9bk4b', note: '孔子（人物，热）' },
  { id: 'd59f2htm01du', note: '直齋書錄解題（整理本，热）' },
  { id: 'd59f1iopaku8', note: 'perf 场景作品（热）' },
  { id: 'd59f2rxf35ds', note: '詩集（裸题作品，冷）' },
  { id: 'd59f2s1eob9c', note: '音（裸题作品，冷）' },
  { id: 'hixhd2h9bcme', note: '蔣良驥（冷门人物）' },
  { id: 'hixhd2h9bdpx', note: '王愈擴（冷门人物）' },
  { id: 'hixhd2h9bfoq', note: '王偕（冷门人物）' },
  { id: 'hixhd2h9bg06', note: '翟鳳翥（冷门人物）' },
];

// 全文页：整理本卷四（e2e/ui/collated.spec.ts 同一个）
const FULLTEXT = '/book-index?id=d59f2htm01du&tab=collated&juan=juan%2F004.json';

// 浏览器指标：首页＋3 个条目页（热、人物、冷各一）
const VITAL_IDS = ['d59f20aowb9c', 'hixhd2h9bk4b', 'd59f2rxf35ds'];

export function loadTargets(env = process.env) {
  if (env.MON_COMPARE_TARGETS) return JSON.parse(env.MON_COMPARE_TARGETS);
  const oldBase = env.MON_WWW || 'https://www.kaiyuanguji.com';
  const newBase = env.MON_COMPARE_NEW || 'https://ssr-test.kaiyuanguji.com';
  return [
    {
      name: 'old', label: '旧·静态（www）', base: oldBase, alert: true,
      // 静态站没有 /item/<id>（动态路由导不出来），只比 /book-index?id=
      pages: { home: '/', 'item:book-index': '/book-index?id={id}', fulltext: FULLTEXT },
      vitals: ['/', ...VITAL_IDS.map((id) => `/book-index?id=${id}`)],
    },
    {
      name: 'new', label: '新·全栈（ssr-test）', base: newBase, alert: false,
      pages: { home: '/', 'item:book-index': '/book-index?id={id}', 'item:ssr': '/item/{id}', fulltext: FULLTEXT },
      vitals: ['/', ...VITAL_IDS.map((id) => `/item/${id}`)],
    },
  ];
}
