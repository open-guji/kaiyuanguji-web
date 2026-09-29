/**
 * 首页「我们在做的事」。只有真正上线的标 live，其余一律「规划中」——
 * 不在首页承诺没做出来的东西。
 */
export interface HomeFeature {
  title: string;
  live: boolean;
  text: string;
  /** 已上线的才有入口：卡片底部一行文字链接 */
  cta?: { label: string; href: string };
}

export const HOME_FEATURES: HomeFeature[] = [
  {
    title: '古籍元数据',
    live: true,
    text: '以作品为纲，把历代官私书目的著录与存世各版本汇到同一条目下，一眼看清一部书的来龙去脉。',
    cta: { label: '进入古籍总目', href: '/catalog' },
  },
  {
    title: '资源收集',
    live: true,
    text: '收集网上已有的文字资源和影印资源，逐条挂到对应的作品与版本下，顺着链接就能查到出处。',
    // 设计稿这里有「看一个例子 →」，但首页已按用户意见（overview#267）去掉了「看一个例子」、
    // 改为搜索框下三个例子，两者冲突，先不放，待用户定（overview#286 评论）。
  },
  {
    title: '图文对读',
    live: false,
    text: '识别出的每个字对回书影上的位置，读文字时随时对看原书。',
  },
  {
    title: '全文检索',
    live: false,
    text: '在书名、作者之外，检索整理本全文；异体、繁简自动归并。',
  },
  {
    title: '协同校对',
    live: false,
    text: '字图对照着改错字、补标点，校对结果回流到公开文本。',
  },
  {
    title: '古籍专用模型',
    live: false,
    text: '用校好的文本训练断句、标点、专名识别，反过来加快整理。',
  },
];
