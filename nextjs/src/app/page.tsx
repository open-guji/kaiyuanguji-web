import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import HomeSearch from '@/components/home/HomeSearch';
import { HOME_FEATURES } from '@/components/home/features';

// 2026-09-29 设计稿 v3（overview#286）：眉题前加短横；检索框改成一体的方框（图标＋输入＋按钮）；
// 「我们在做的事」已上线的做成抬起的卡片并带入口，规划中的用虚线框；「文本开放／代码开源」标题前加许可徽标，
// 仓库清单一行一个、右端 ↗。首屏坤舆图与页脚二维码按用户意见保留（设计稿里是占位）。
// 首页（N1，照 design/n1-samples 的 /samples/home）：
// 首屏坤舆图满幅、左对齐大标题、大检索框、唯一主按钮「搜索」；
// 特性区只有已上线的两项标「已上线」，其余标「规划中」；写明 CC0。
// 「一起把古籍做成开放数据」一段已删（用户意见，overview#267）：关于、联系、反馈在页脚里都有。
// 搜索框下面的三个例子（用户意见，overview#267）：只写名字，点进去分别是作品页、丛编页、阅读页。
//   史记 → 作品页（史記 d59f20aowb9c）
//   四库全书 → 丛编页（欽定四庫全書·文淵閣本 8rlb6yi1ecqo，四庫全書七阁之首，没有更上一级的总丛编）
//   红楼梦程甲本 → 直接进阅读页（新鐫全部繡像紅樓夢·程甲本 96kzkdm8e8 的全文，维基文库 120 回；09-30 用户重申，取代此前的「甲戌本」）
const HOME_EXAMPLES = [
  { label: '史记', href: '/item/d59f20aowb9c' },
  { label: '四库全书', href: '/item/8rlb6yi1ecqo' },
  { label: '红楼梦程甲本', href: '/read/96kzkdm8e8' },
];

// 「文本开放、代码开源」两栏（用户意见，overview#267）。仓库地址与说明已对照各仓 README 核实：
// book-index 只存元数据，book-text 存整理本与全文（CC0）；luatex-cn、bookget-py 为 Apache-2.0。
const GITHUB = 'https://github.com/open-guji';
const OPEN_TEXT_REPOS = [
  { name: 'book-text', note: '整理本、輯佚与全文' },
  { name: 'book-index', note: '古籍目录索引，只存元数据：作品、版本、丛编、人物条目' },
];
const OPEN_CODE_REPOS = [
  { name: 'luatex-cn', note: '基于 LuaTeX 的中文排版包：古籍竖排版式复刻，以及现代中文排版，已上 CTAN' },
  { name: 'bookget-py', note: '古籍数字资源下载与管理工具，支持 37 个数字图书馆站点，走 IIIF' },
];

export default function HomePage() {
  return (
    <LayoutWrapper navOnHero>
      <section className="home-hero">
        {/* 用 <picture> 而不是 CSS 背景：预加载扫描器能在 HTML 里直接发现它，
            手机拿 800px 小图；fetchPriority=high 让首屏大图先下 */}
        <picture className="home-hero-bg" aria-hidden="true">
          <source media="(max-width: 760px)" srcSet="/images/kunyu-hero-m.webp" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/kunyu-hero.webp" alt="" width={1600} height={1337} fetchPriority="high" />
        </picture>
        <div className="home-hero-veil" aria-hidden="true" />
        <div className="home-hero-inner">
          <p className="home-kicker">古籍数字化开放平台</p>
          <h1 className="home-title">让科技赋予古籍数字生命</h1>
          <p className="home-lead">
            把散在各处的历代书目、存世版本与文本聚到一起，建一座开放、可查证、自由使用的古籍文库。
          </p>
          <HomeSearch />
          <p className="home-under">
            <span>已收录 11 万+ 条古籍索引</span>
            {HOME_EXAMPLES.map((e) => (
              <Link key={e.href} href={e.href}>
                {e.label}
              </Link>
            ))}
          </p>
        </div>
      </section>

      <section className="home-band" aria-labelledby="home-features-title">
        <div className="home-band-head">
          <h2 id="home-features-title">我们在做的事</h2>
          <span className="home-meta">古籍元数据、资源收集已上线，其余在陆续推进</span>
        </div>
        <ul className="home-features">
          {HOME_FEATURES.map((f, i) => (
            <li key={f.title} className={f.live ? 'home-feature is-live' : 'home-feature'}>
              <span className="num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3>
                {f.title}
                <span className={f.live ? 'status is-live' : 'status'}>{f.live ? '已上线' : '规划中'}</span>
              </h3>
              <p>{f.text}</p>
              {f.cta && (
                <Link className="home-feature-cta" href={f.cta.href}>
                  {f.cta.label} <span aria-hidden="true">→</span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="home-open" aria-label="开放">
        <div className="home-open-inner">
          <div className="home-open-col">
            <div className="home-open-head"><span className="home-badge" aria-label="许可：CC0">CC0</span><h2>文本开放</h2></div>
            <p className="home-open-sub">整理本与全文以 CC0 公有领域发布，可自由复制、改编、再发布，无需署名。</p>
            <ul className="home-repos">
              {OPEN_TEXT_REPOS.map((r) => (
                <li key={r.name}>
                  <a href={`${GITHUB}/${r.name}`} target="_blank" rel="noopener noreferrer">
                    {r.name}<span className="home-repo-arrow" aria-hidden="true"> ↗</span>
                  </a>
                  <span>{r.note}</span>
                </li>
              ))}
            </ul>
            <p className="home-open-note">
              转录自维基文库、Kanripo 的全文沿用来源许可（CC BY-SA），每部全文的阅读页顶部标有来源与许可，详见
              <Link href="/about">关于我们</Link>的「数据来源与授权」。
            </p>
          </div>
          <div className="home-open-col">
            <div className="home-open-head"><span className="home-badge" aria-label="许可：Apache-2.0">Apache-2.0</span><h2>代码开源</h2></div>
            <p className="home-open-sub">
              网站、排版、资源抓取等工具以 Apache-2.0 开源。<a href={GITHUB} target="_blank" rel="noopener noreferrer">在 GitHub 查看全部 →</a>
            </p>
            <ul className="home-repos">
              {OPEN_CODE_REPOS.map((r) => (
                <li key={r.name}>
                  <a href={`${GITHUB}/${r.name}`} target="_blank" rel="noopener noreferrer">
                    {r.name}<span className="home-repo-arrow" aria-hidden="true"> ↗</span>
                  </a>
                  <span>{r.note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </LayoutWrapper>
  );
}
