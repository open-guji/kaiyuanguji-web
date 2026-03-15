'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser } from 'book-index-ui';
import { GithubTransport } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import {
  GITHUB_ORG,
  JSDELIVR_FASTLY,
  JSDELIVR_CDN,
} from '@/lib/constants';

export default function BookIndexPage() {
  const router = useRouter();
  const { source } = useSource();

  const transport = useMemo(() => {
    const baseUrl = source === 'github'
      ? 'https://raw.githubusercontent.com'
      : undefined;

    return new GithubTransport({
      org: GITHUB_ORG,
      repos: {
        draft: 'book-index-draft',
        official: 'book-index',
      },
      baseUrl,
      cdnUrls: [JSDELIVR_FASTLY, JSDELIVR_CDN],
    });
  }, [source]);

  const handleEntryClick = (entry: IndexEntry) => {
    router.push(`/book-index/${entry.id}`);
  };

  return (
    <LayoutWrapper hideFooter>
      <div className="max-w-5xl mx-auto py-8 px-4">
        <IndexBrowser
          transport={transport}
          hideModeIndicator
          onEntryClick={handleEntryClick}
        />
      </div>
    </LayoutWrapper>
  );
}
