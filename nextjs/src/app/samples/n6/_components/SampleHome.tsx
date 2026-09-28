import Link from 'next/link';
import HomeSearch from '@/components/home/HomeSearch';
import { HOME_FEATURES } from '@/components/home/features';
import SampleShell from './SampleShell';
import { ABOUT_HREF, CONTACT_HREF } from './links';

/**
 * 首页样张。首屏和特性区与现网 page.tsx 相同，只动页尾：
 * - A：开放区之后另起一段「关于与联系」（三列文字链接，不加按钮）；
 * - B：不加新段，开放区从两栏变三栏，第三栏是「关于与联系」。
 */
export default function SampleHome({ variant }: { variant: 'a' | 'b' }) {
  return (
    <SampleShell navOnHero>
      <section className="home-hero">
        <picture className="home-hero-bg" aria-hidden="true">
          <source media="(max-width: 760px)" srcSet="/images/kunyu-hero-m.webp" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/kunyu-hero.webp" alt="" width={1600} height={1337} fetchPriority="high" />
        </picture>
        <div className="home-hero-veil" aria-hidden="true" />
        <div className="home-hero-inner">
          <p className="home-kicker">开源古籍 · 古籍数字化开放平台</p>
          <h1 className="home-title">让科技赋予古籍数字生命</h1>
          <p className="home-lead">
            把散在各处的历代书目、存世版本与整理文本聚到一起，建一座开放、可查证、自由使用的古籍文库。
          </p>
          <HomeSearch />
          <p className="home-under">
            <span>已收录 11 万+ 条古籍索引</span>
            <Link href="/book-index?id=d59f20aowb9c">看一个例子：《史記》→</Link>
            <Link href="/book-index?id=d59f2htm01du&tab=collated">读整理本《直齋書錄解題》→</Link>
          </p>
        </div>
      </section>

      <section className="home-band" aria-labelledby="home-features-title">
        <div className="home-band-head">
          <h2 id="home-features-title">我们在做的事</h2>
          <span className="home-meta">目录与版本聚类、整理本阅读已上线，其余在陆续推进</span>
        </div>
        <ul className="home-features">
          {HOME_FEATURES.map((f, i) => (
            <li key={f.title} className="home-feature">
              <span className="num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3>
                {f.title}
                <span className={f.live ? 'status is-live' : 'status'}>{f.live ? '已上线' : '规划中'}</span>
              </h3>
              <p>{f.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="home-open">
        <div className={variant === 'b' ? 'home-open-inner n6-open-3' : 'home-open-inner'}>
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
          {variant === 'b' && (
            <div>
              <h2>关于与联系</h2>
              <p>
                项目由谁在做、数据从哪来，见<Link href={ABOUT_HREF}>关于我们</Link>；
                发现错误、想参与，见<Link href={CONTACT_HREF}>联系我们</Link>。
              </p>
            </div>
          )}
        </div>
      </section>

      {variant === 'a' && (
        <section className="n6-join" aria-labelledby="n6-join-title">
          <div className="n6-join-inner">
            <div className="n6-join-head">
              <h2 id="n6-join-title">一起把古籍做成开放数据</h2>
              <p>这是一个开源项目，书目、文本和代码都放在 GitHub 上。发现错误、缺了资源，或者想参与整理，都欢迎来找我们。</p>
            </div>
            <ul className="n6-join-links">
              <li>
                <Link href={ABOUT_HREF}>
                  <strong>关于我们 →</strong>
                  <span>项目在做什么、数据来源与授权、致谢</span>
                </Link>
              </li>
              <li>
                <Link href={CONTACT_HREF}>
                  <strong>联系我们 →</strong>
                  <span>反馈、GitHub、〔邮箱待定〕、〔公众号／群待定〕</span>
                </Link>
              </li>
              <li>
                <Link href="/feedback">
                  <strong>反馈与纠错 →</strong>
                  <span>看到哪里不对，随手提交，可以跟踪处理进展</span>
                </Link>
              </li>
            </ul>
          </div>
        </section>
      )}
    </SampleShell>
  );
}
