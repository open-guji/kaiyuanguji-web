import Link from 'next/link';
import SampleShell from '../_components/SampleShell';
import { ABOUT_HREF } from '../_components/links';

const GH = 'https://github.com/open-guji';

export default function N6Contact() {
  return (
    <SampleShell>
      <div className="n6-page">
        <h1>联系我们</h1>
        <p className="n6-lead">发现错误、缺了资源、有建议，或者想参与整理、校对、开发，都可以从下面任一处找到我们。</p>

        <section className="n6-primary">
          <div>
            <h2>反馈与纠错</h2>
            <p>
              最快的方式。条目页和每页右下角都有反馈入口，提交后可在反馈页看到处理进展。想参与的话，类型选「想参与」并留下联系方式。
            </p>
          </div>
          <Link href="/feedback" className="og-btn">
            去反馈
          </Link>
        </section>

        <dl className="n6-ways">
          <dt>GitHub</dt>
          <dd>
            书目数据有误：
            <a href={`${GH}/book-index/issues`} target="_blank" rel="noopener noreferrer">
              book-index Issues
            </a>
            <br />
            网站问题：
            <a href={`${GH}/kaiyuanguji-web/issues`} target="_blank" rel="noopener noreferrer">
              kaiyuanguji-web Issues
            </a>
            <span className="n6-meta">也欢迎直接提 PR</span>
          </dd>

          <dt>邮箱</dt>
          <dd>
            <span className="n6-ph">〔邮箱待定〕</span>
            <span className="n6-meta">合作、授权、媒体等不便公开的事</span>
          </dd>

          <dt>公众号与交流群</dt>
          <dd>
            <div className="n6-qrs">
              <figure>
                <span className="n6-qr" role="img" aria-label="公众号二维码占位">
                  〔公众号二维码
                  <br />
                  图待提供〕
                </span>
                <figcaption>〔公众号名称待定〕</figcaption>
              </figure>
              <figure>
                <span className="n6-qr" role="img" aria-label="交流群二维码占位">
                  〔交流群二维码
                  <br />
                  图待提供〕
                </span>
                <figcaption>〔群名待定〕</figcaption>
              </figure>
            </div>
          </dd>
        </dl>

        <p className="n6-note">
          项目本身的介绍、数据来源与授权，见<Link href={ABOUT_HREF}>关于我们</Link>。
        </p>
      </div>
    </SampleShell>
  );
}
