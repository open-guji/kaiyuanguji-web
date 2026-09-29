import Link from 'next/link';
import { Metadata } from 'next';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { GITHUB_ORG } from '@/lib/constants';

export const metadata: Metadata = {
  title: '联系我们',
  description: '发现错误、缺了资源、有建议或想参与开源古籍，可以通过站内反馈、GitHub Issues、邮箱或 QQ 群找到我们。',
};

const GITHUB_BASE = `https://github.com/${GITHUB_ORG}`;

// N6（overview#259）：只放用户给定的联系方式。没有公众号；微信群二维码等图给了再加，不放占位。
const CONTACT_EMAIL = 'sheldonli.dev@gmail.com';
const QQ_GROUP = '111362573';
export default function ContactPage() {
  return (
    <LayoutWrapper>
      <div className="doc-page">
        <h1>联系我们</h1>
        <p className="doc-lead">发现错误、缺了资源、有建议，或者想参与整理、校对、开发，都可以从下面找到我们。</p>

        <section className="contact-primary" aria-labelledby="contact-feedback">
          <div>
            <h2 id="contact-feedback">反馈与纠错</h2>
            <p>最快的方式。提交后可以在反馈页看到处理进展；想参与的话，类型选「想参与」并留下联系方式，我们会联系你。</p>
          </div>
          <Link href="/feedback" className="og-btn">
            去反馈
          </Link>
        </section>

        <dl className="contact-ways">
          <dt>GitHub</dt>
          <dd>
            书目数据有误：
            <a href={`${GITHUB_BASE}/book-index/issues`} target="_blank" rel="noopener noreferrer">
              book-index Issues
            </a>
            <br />
            网站问题：
            <a href={`${GITHUB_BASE}/kaiyuanguji-web/issues`} target="_blank" rel="noopener noreferrer">
              kaiyuanguji-web Issues
            </a>
            <span className="doc-meta">也欢迎直接提 PR</span>
          </dd>

          <dt>邮箱</dt>
          <dd>
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            <span className="doc-meta">合作、授权等不便公开的事</span>
          </dd>

          <dt>交流群</dt>
          <dd>
            QQ 群：{QQ_GROUP}
            <span className="doc-meta">在 QQ 里搜索群号加入</span>
          </dd>
        </dl>

        <p className="doc-note">
          项目本身的介绍、数据来源与授权，见<Link href="/about">关于我们</Link>。
        </p>
      </div>
    </LayoutWrapper>
  );
}
