import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { T } from '@/i18n';

export const metadata: Metadata = {
  title: '隐私说明',
  description: '开源古籍网站收集哪些访问数据、用来做什么、保留多久，以及如何拒绝。',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPage() {
  return (
    <LayoutWrapper>
      <article className="og-paper mx-auto max-w-3xl px-5 py-12 leading-relaxed text-[var(--color-ink,#222)]">
        <h1 className="mb-6 text-2xl font-bold"><T k="pages.privacy.title" /></h1>
        <p className="mb-4"><T k="pages.privacy.intro" /></p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.privacy.statsHeading" /></h2>
        <p className="mb-4">
          <T k="pages.privacy.statsBefore" />
          <strong><T k="pages.privacy.baidu" /></strong>
          <T k="pages.privacy.statsMiddle" />
          <strong>Google Analytics</strong>
          <T k="pages.privacy.statsAfter" />
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.privacy.errorsHeading" /></h2>
        <p className="mb-4">
          <T k="pages.privacy.errorsBody" />
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.privacy.feedbackHeading" /></h2>
        <p className="mb-4"><T k="pages.privacy.feedbackBody" /></p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.privacy.optOutHeading" /></h2>
        <p className="mb-4">
          <T k="pages.privacy.optOutBody" />
        </p>
      </article>
    </LayoutWrapper>
  );
}
