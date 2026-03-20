'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';

export default function BookIndexPage() {
  const router = useRouter();
  const { source } = useSource();

  const transport = useMemo(() => getTransport(source), [source]);

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
