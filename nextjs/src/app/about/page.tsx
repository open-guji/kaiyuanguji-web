import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { GITHUB_ORG } from '@/lib/constants';

export const metadata: Metadata = {
  title: '关于开源古籍',
  description: '开源古籍是什么、数据与代码以什么许可开放、以及怎么找到我们：站内反馈、GitHub Issues、邮箱、QQ 群、微信群。',
  alternates: { canonical: '/about' },
};

// N6（overview#259）：左侧目录＋分节正文。团队一节等用户给了名单再加，不放占位。
// 用户意见（overview#267）：去掉「项目介绍」「开源仓库」两节（首页「我们在做的事」「文本开放、代码开源」里有）。
// 用户 9-30 反馈（overview#322）：重写「数据来源与授权」（book-index 也是 CC0，不提 book-index-draft，口径同首页）；
// 删「本站呈现的内容不是最终事实来源……」一段；联系页内容直接展开在本页（/contact 跳到 #联系）。
// 用户 10-01 反馈（overview#337 B8）：「数据来源与授权」只留表格；开头一段换成用户给的原文（一字不改）。
const TOC = [
  { id: 'license', label: '数据来源与授权' },
  { id: 'thanks', label: '致谢' },
  { id: '联系', label: '联系我们' },
];

const THANKS = [
  { name: '维基文库', note: '部分文本转录自此，CC BY-SA 4.0', href: 'https://zh.wikisource.org/' },
  { name: 'Kanripo（漢籍リポジトリ）', note: '部分文本转录自此，CC BY-SA', href: 'https://www.kanripo.org/' },
];

const GITHUB_BASE = `https://github.com/${GITHUB_ORG}`;

// 授权口径与首页「文本开放、代码开源」一致
const LICENSES = [
  {
    what: '古籍目录索引（book-index）',
    note: '作品、版本、丛编、人物条目，只存元数据',
    license: 'CC0 1.0 Universal，公有领域，可自由复制、改编、再发布，无需署名',
  },
  {
    what: '古籍文本（book-text）',
    note: '本站整理的古籍文本与輯佚',
    license: 'CC0 1.0 Universal，公有领域，可自由复制、改编、再发布，无需署名',
  },
  {
    what: '转录自第三方的文本',
    note: '维基文库、Kanripo 等',
    license:
      '沿用来源许可，不适用 CC0：维基文库为 CC BY-SA 4.0，Kanripo 为 CC BY-SA。每部文本的阅读页顶部标有来源名称、原始链接和许可，转载时请按对应许可署名，并以相同许可发布',
  },
  {
    what: '代码',
    note: '网站、排版（luatex-cn）、资源抓取（bookget-py）、图片数字化（open-guji-cv）等',
    license: 'Apache License 2.0',
  },
];

// N6（overview#259）：只放用户给定的联系方式。没有公众号。
// 微信群二维码 7 天过期，过期后换 public/images/wechat-group-qr.png。
const CONTACT_EMAIL = 'sheldonli.dev@gmail.com';
const QQ_GROUP = '111362573';

export default function AboutPage() {
  return (
    <LayoutWrapper>
      <div className="og-paper doc-layout">
        <nav className="doc-toc" aria-label="本页目录">
          <p className="doc-toc-title">关于开源古籍</p>
          <ul>
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="doc-article">
          <h1>关于开源古籍</h1>
          <p className="doc-lead">
            知识属于全人类。只有开源，才能使绝学继于往世。本站主要收录已进入公有领域的中国古籍及其他文字载体，亦包括少数民族语言文字和海外所载。项目范围包括古籍编目，影印资源搜集，文本化，构建知识图谱等等。
          </p>
          <p className="doc-lead">
            开源古籍是一个开放的，非盈利的团体。欢迎任何人以任何方式加入和贡献，唯一的要求就是所有成果必须开源发布。
          </p>

          <section id="license">
            <h2>数据来源与授权</h2>
            <table className="doc-table">
              <tbody>
                {LICENSES.map((l) => (
                  <tr key={l.what}>
                    <th scope="row">
                      {l.what}
                      <span className="doc-meta">{l.note}</span>
                    </th>
                    <td>{l.license}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section id="thanks">
            <h2>致谢</h2>
            <p>项目的探索离不开开放知识社群的积累，特此致谢：</p>
            <ul className="doc-rows">
              {THANKS.map((t) => (
                <li key={t.name}>
                  <a href={t.href} target="_blank" rel="noopener noreferrer">
                    {t.name}
                  </a>
                  <span className="doc-meta">{t.note}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="联系" aria-labelledby="about-contact">
            <h2 id="about-contact">联系我们</h2>
            <p>发现错误、缺了资源、有建议，或者想参与整理、校对、开发，都可以从下面找到我们。</p>

            <div className="contact-primary">
              <div>
                <h3>反馈与纠错</h3>
                <p>最快的方式。提交后可以在反馈页看到处理进展；想参与的话，类型选「想参与」并留下联系方式，我们会联系你。</p>
              </div>
              <Link href="/feedback" className="og-btn">
                去反馈
              </Link>
            </div>

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
                <div className="contact-qrs">
                  <figure className="contact-qr">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/wechat-group-qr.png" alt="微信群「开源古籍交流群」二维码" width={160} height={160} loading="lazy" />
                    <figcaption>微信群：微信扫码加入</figcaption>
                  </figure>
                  <figure className="contact-qr">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/qq-group-qr.png" alt="QQ 群「开源古籍交流群」二维码" width={160} height={160} loading="lazy" />
                    <figcaption>
                      QQ 群：{QQ_GROUP}
                      <br />
                      QQ 扫码或搜索群号加入
                    </figcaption>
                  </figure>
                </div>
              </dd>
            </dl>

            <p>
              内测阶段的功能范围与已知限制见<Link href="/beta">内测说明</Link>，隐私相关见<Link href="/privacy">隐私说明</Link>。
            </p>
          </section>
        </article>
      </div>
    </LayoutWrapper>
  );
}
