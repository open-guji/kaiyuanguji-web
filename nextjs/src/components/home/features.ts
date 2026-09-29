/**
 * 首页「我们在做的事」。只有真正上线的标 live，其余一律「规划中」——
 * 不在首页承诺没做出来的东西。
 */
export interface HomeFeature {
  title: string;
  live: boolean;
  text: string;
}

export const HOME_FEATURES: HomeFeature[] = [
  {
    title: '古籍元数据',
    live: true,
    text: '以作品为纲，把历代官私书目的著录与存世各版本汇到同一条目下，一眼看清一部书的来龙去脉。',
  },
  {
    title: '资源收集',
    live: true,
    text: '收集网上已有的文字资源和影印资源，逐条挂到对应的作品与版本下，顺着链接就能查到出处。',
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
