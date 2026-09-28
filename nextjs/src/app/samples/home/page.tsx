import Link from 'next/link';
import SampleNav from '../_components/SampleNav';

// 样张一：首页首屏。布局学新稿（满幅坤舆图＋左对齐大标题＋大检索框＋特性区），
// 视觉沿用现网（暖纸罩、朱色只给主按钮和链接）。未上线的功能一律标「规划中」。
const FEATURES = [
  {
    title: '四部目录与版本聚类',
    live: true,
    text: '以作品为纲，把历代官私书目的著录与存世各版本汇到同一条目下，一眼看清一部书的来龙去脉。',
  },
  {
    title: '整理本阅读',
    live: true,
    text: '书目、正史等整理本按卷分篇、横排宋体阅读，条目与索引互相跳转。',
  },
  {
    title: '书影与文字逐字对照',
    live: false,
    text: '识别出的每个字对回书影上的位置，读文字时随时对看原书。',
  },
  {
    title: '全文与语义检索',
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

export default function SampleHome() {
  return (
    <>
      <SampleNav active="home" onHero />
      <section className="home-hero">
        <div className="home-hero-bg" aria-hidden="true" />
        <div className="home-hero-veil" aria-hidden="true" />
        <div className="home-hero-inner">
          <p className="home-kicker">开源古籍 · 古籍数字化开放平台</p>
          <h1 className="home-title">让科技赋予古籍数字生命</h1>
          <p className="home-lead">
            把散在各处的历代书目、存世版本与整理文本聚到一起，建一座开放、可查证、自由使用的古籍文库。
          </p>
          <form className="home-search" action="/book-index" method="get" role="search">
            <input
              type="search"
              name="q"
              placeholder="书名、作者、版本，如：史記、陳振孫"
              aria-label="搜索古籍索引"
            />
            <button type="submit" className="s-btn">搜索</button>
          </form>
          <p className="home-under">
            已收录 11 万+ 条古籍索引
            <Link href="/samples/item">看一个例子：《史記》→</Link>
            <Link href="/samples/reader">读整理本《直齋書錄解題》→</Link>
          </p>
        </div>
      </section>

      <section className="home-band">
        <div className="home-band-head">
          <h2>我们在做的事</h2>
          <span className="meta">目录与版本聚类已上线，其余在陆续推进</span>
        </div>
        <div className="home-features">
          {FEATURES.map((f, i) => (
            <div key={f.title} className="home-feature">
              <span className="num">{String(i + 1).padStart(2, '0')}</span>
              <h3>
                {f.title}
                {f.live ? <span className="live">已上线</span> : <span className="meta">规划中</span>}
              </h3>
              <p>{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="home-open">
        <div className="home-open-inner">
          <div>
            <h2>文本开放</h2>
            <p>站内全部文本以 CC0 公有领域发布，可自由复制、改编、再发布，无需署名。</p>
          </div>
          <div>
            <h2>代码开源</h2>
            <p>
              网站、排版（LuaTeX-cn）、资源抓取（bookget-py）等工具以 Apache-2.0 开源，
              <a href="https://github.com/open-guji">在 GitHub 查看 →</a>
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
