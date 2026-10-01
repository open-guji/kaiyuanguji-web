import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { GITHUB_ORG } from '@/lib/constants';
import { T, type SiteMessageKey } from '@/i18n';
import { LabeledNav, LocalizedImg } from './AboutLocalized';

export const metadata: Metadata = {
  title: '关于开源古籍',
  description: '开源古籍是什么、数据与代码以什么许可开放、以及怎么找到我们：站内反馈、GitHub Issues、邮箱、QQ 群、微信群。',
  alternates: { canonical: '/about' },
};

// N6（overview#259）：左侧目录＋分节正文。团队一节等用户给了名单再加，不放占位。
// 用户意见（overview#267）：去掉「项目介绍」「开源仓库」两节（首页「我们在做的事」「文本开放、代码开源」里有）。
// 用户 9-30 反馈（overview#322）：重写「数据来源与授权」（book-index 也是 CC0，不提 book-index-draft，口径同首页）；
// 删「本站呈现的内容不是最终事实来源……」一段；联系页内容直接展开在本页（/contact 跳到 #联系）。
// 用户 10-01 反馈（overview#337 B8）：「数据来源与授权」只留表格；开头一段换成用户给的原文（about.lead1／lead2，一字不改）。
// 界面文字在 i18n/messages/about.ts（overview#337），这里只放键
const TOC: Array<{ id: string; label: SiteMessageKey }> = [
  { id: 'license', label: 'about.toc.license' },
  { id: 'thanks', label: 'about.toc.thanks' },
  { id: '联系', label: 'about.toc.contact' },
];

// 「Kanripo（漢籍リポジトリ）」是专名，繁简都照原样，不进字典（字典测试查简体栏残留繁体字）
const KANRIPO_NAME = 'Kanripo（漢籍リポジトリ）';

const THANKS: Array<{ id: string; name: SiteMessageKey | { literal: string }; note: SiteMessageKey; href: string }> = [
  { id: 'wikisource', name: 'about.thanks.wikisource', note: 'about.thanks.wikisourceNote', href: 'https://zh.wikisource.org/' },
  { id: 'kanripo', name: { literal: KANRIPO_NAME }, note: 'about.thanks.kanripoNote', href: 'https://www.kanripo.org/' },
];

const GITHUB_BASE = `https://github.com/${GITHUB_ORG}`;

// 授权口径与首页「文本开放、代码开源」一致；各行文字见 about.license.<id>.*
const LICENSES = ['bookIndex', 'bookText', 'thirdParty', 'code'] as const;

// N6（overview#259）：只放用户给定的联系方式。没有公众号。
// 微信群二维码 7 天过期，过期后换 public/images/wechat-group-qr.png。
const CONTACT_EMAIL = 'sheldonli.dev@gmail.com';
const QQ_GROUP = '111362573';

export default function AboutPage() {
  return (
    <LayoutWrapper>
      <div className="og-paper doc-layout">
        <LabeledNav className="doc-toc" labelKey="about.tocAria">
          <p className="doc-toc-title"><T k="about.title" /></p>
          <ul>
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}><T k={t.label} /></a>
              </li>
            ))}
          </ul>
        </LabeledNav>

        <article className="doc-article">
          <h1><T k="about.title" /></h1>
          <p className="doc-lead">
            <T k="about.lead1" />
          </p>
          <p className="doc-lead">
            <T k="about.lead2" />
          </p>

          <section id="license">
            <h2><T k="about.toc.license" /></h2>
            <table className="doc-table">
              <tbody>
                {LICENSES.map((id) => (
                  <tr key={id}>
                    <th scope="row">
                      <T k={`about.license.${id}.what`} />
                      <span className="doc-meta"><T k={`about.license.${id}.note`} /></span>
                    </th>
                    <td><T k={`about.license.${id}.license`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section id="thanks">
            <h2><T k="about.toc.thanks" /></h2>
            <p><T k="about.thanks.intro" /></p>
            <ul className="doc-rows">
              {THANKS.map((t) => (
                <li key={t.id}>
                  <a href={t.href} target="_blank" rel="noopener noreferrer">
                    {typeof t.name === 'string' ? <T k={t.name} /> : t.name.literal}
                  </a>
                  <span className="doc-meta"><T k={t.note} /></span>
                </li>
              ))}
            </ul>
          </section>

          <section id="联系" aria-labelledby="about-contact">
            <h2 id="about-contact"><T k="about.toc.contact" /></h2>
            <p><T k="about.contact.intro" /></p>

            <div className="contact-primary">
              <div>
                <h3><T k="about.contact.feedbackTitle" /></h3>
                <p><T k="about.contact.feedbackDesc" /></p>
              </div>
              <Link href="/feedback" className="og-btn">
                <T k="about.contact.feedbackBtn" />
              </Link>
            </div>

            <dl className="contact-ways">
              <dt>GitHub</dt>
              <dd>
                <T k="about.contact.bookDataIssue" />
                <a href={`${GITHUB_BASE}/book-index/issues`} target="_blank" rel="noopener noreferrer">
                  book-index Issues
                </a>
                <br />
                <T k="about.contact.siteIssue" />
                <a href={`${GITHUB_BASE}/kaiyuanguji-web/issues`} target="_blank" rel="noopener noreferrer">
                  kaiyuanguji-web Issues
                </a>
                <span className="doc-meta"><T k="about.contact.prWelcome" /></span>
              </dd>

              <dt><T k="about.contact.email" /></dt>
              <dd>
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                <span className="doc-meta"><T k="about.contact.emailNote" /></span>
              </dd>

              <dt><T k="about.contact.groups" /></dt>
              <dd>
                <div className="contact-qrs">
                  <figure className="contact-qr">
                    <LocalizedImg src="/images/wechat-group-qr.png" altKey="about.contact.wechatAlt" width={160} height={160} loading="lazy" />
                    <figcaption><T k="about.contact.wechatCaption" /></figcaption>
                  </figure>
                  <figure className="contact-qr">
                    <LocalizedImg src="/images/qq-group-qr.png" altKey="about.contact.qqAlt" width={160} height={160} loading="lazy" />
                    <figcaption>
                      <T k="about.contact.qqGroup" vars={{ group: QQ_GROUP }} />
                      <br />
                      <T k="about.contact.qqHint" />
                    </figcaption>
                  </figure>
                </div>
              </dd>
            </dl>

            <p>
              <T k="about.contact.moreBefore" />
              <Link href="/beta"><T k="about.contact.betaLink" /></Link>
              <T k="about.contact.moreMiddle" />
              <Link href="/privacy"><T k="about.contact.privacyLink" /></Link>
              <T k="about.contact.moreAfter" />
            </p>
          </section>
        </article>
      </div>
    </LayoutWrapper>
  );
}
