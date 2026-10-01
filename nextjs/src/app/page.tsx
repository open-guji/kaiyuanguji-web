import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import HomeSearch from '@/components/home/HomeSearch';
import HomeFeatures from '@/components/home/HomeFeatures';
import HomeOpen from '@/components/home/HomeOpen';
import T from '@/i18n/T';
import type { SiteMessageKey } from '@/i18n/translate';

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
// 界面文字走字典（overview#337）：服务端组件用 <T>，首帧简体，挂载后跟随繁简偏好。
const HOME_EXAMPLES: { labelKey: SiteMessageKey; href: string }[] = [
  { labelKey: 'home.examples.shiji', href: '/item/d59f20aowb9c' },
  { labelKey: 'home.examples.siku', href: '/item/8rlb6yi1ecqo' },
  { labelKey: 'home.examples.hongloumeng', href: '/read/96kzkdm8e8' },
];

// 「文本开放、代码开源」两栏在 components/home/HomeOpen（属性文字要跟繁简偏好，做成了客户端组件）。

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
          <p className="home-kicker"><T k="home.kicker" /></p>
          <h1 className="home-title"><T k="home.title" /></h1>
          <p className="home-lead">
            <T k="home.lead" />
          </p>
          <HomeSearch />
          <p className="home-under">
            <span><T k="home.count" /></span>
            {HOME_EXAMPLES.map((e) => (
              <Link key={e.href} href={e.href}>
                <T k={e.labelKey} />
              </Link>
            ))}
          </p>
        </div>
      </section>

      <section className="home-band" aria-labelledby="home-features-title">
        <div className="home-band-head">
          <h2 id="home-features-title"><T k="home.featuresTitle" /></h2>
          <span className="home-meta"><T k="home.featuresMeta" /></span>
        </div>
        <HomeFeatures />
      </section>

      <HomeOpen />
    </LayoutWrapper>
  );
}
