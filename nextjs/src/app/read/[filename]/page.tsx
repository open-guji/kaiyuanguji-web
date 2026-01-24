import { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';

interface ReadPageProps {
  params: Promise<{ filename: string }>;
}

// ... existing generateMetadata ...

// ... existing generateStaticParams ...

export default async function ReadPage({ params }: ReadPageProps) {
  const { filename } = await params;
  return <MarkdownPageContent filename={filename} />;
}
