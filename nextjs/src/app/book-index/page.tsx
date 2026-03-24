'use client';

import { Suspense, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import BookDetailContent from '@/components/book-index/BookDetailContent';

function BookIndexContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { source } = useSource();

  const transport = useMemo(() => getTransport(source), [source]);

  const detailId = searchParams.get('id');

  const handleEntryClick = (entry: IndexEntry) => {
    router.push(`/book-index?id=${entry.id}`);
  };

  if (detailId) {
    return <BookDetailContent id={detailId} />;
  }

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

export default function BookIndexPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-paper" />}>
      <BookIndexContent />
    </Suspense>
  );
}
