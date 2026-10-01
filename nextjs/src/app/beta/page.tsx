import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { T } from '@/i18n';

export const metadata: Metadata = {
  title: '内测说明',
  description: '开源古籍现在能用什么、有哪些已知限制、数据会不会变、怎么报问题。',
};

export default function BetaPage() {
  return (
    <LayoutWrapper>
      <article className="mx-auto max-w-3xl px-5 py-12 leading-relaxed text-[var(--color-ink,#222)]">
        <h1 className="mb-6 text-2xl font-bold"><T k="pages.beta.title" /></h1>

        <p className="mb-4">
          <T k="pages.beta.intro" />
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.beta.availableHeading" /></h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li><T k="pages.beta.available.search" /></li>
          <li><T k="pages.beta.available.entries" /></li>
          <li><T k="pages.beta.available.texts" /></li>
          <li><T k="pages.beta.available.feedback" /></li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.beta.limitsHeading" /></h2>
        <ul className="mb-4 list-disc space-y-1 pl-6">
          <li><T k="pages.beta.limits.reader" /></li>
          <li><T k="pages.beta.limits.fullTextSearch" /></li>
          <li><T k="pages.beta.limits.images" /></li>
        </ul>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.beta.reportHeading" /></h2>
        <p className="mb-4">
          <T k="pages.beta.reportBefore" />
          <Link href="/feedback" className="text-[var(--color-vermilion)] underline"> <T k="pages.beta.reportLink" /></Link>
          <T k="pages.beta.reportAfter" />
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.beta.dataHeading" /></h2>
        <p className="mb-4">
          <T k="pages.beta.dataBefore" />
          <Link href="/about" className="text-[var(--color-vermilion)] underline"> <T k="pages.beta.dataLink" /></Link>
          <T k="pages.beta.dataAfter" />
        </p>

        <h2 className="mb-2 mt-8 text-lg font-semibold"><T k="pages.beta.privacyHeading" /></h2>
        <p className="mb-4">
          <T k="pages.beta.privacyBefore" />
          <Link href="/privacy" className="text-[var(--color-vermilion)] underline"> <T k="pages.beta.privacyLink" /></Link>
          <T k="pages.beta.privacyAfter" />
        </p>
      </article>
    </LayoutWrapper>
  );
}
