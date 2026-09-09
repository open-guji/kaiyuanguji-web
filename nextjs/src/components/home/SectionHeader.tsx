import Link from 'next/link';

interface SectionHeaderProps {
  title: string;
  subtitle: string;
  href?: string;
  /** 是否显示标题下的朱砂短线（专题分区不显示，对齐设计稿） */
  rule?: boolean;
}

export default function SectionHeader({
  title,
  subtitle,
  href,
  rule = true,
}: SectionHeaderProps) {
  const TitleContent = (
    <div className="group flex items-center gap-2">
      <h2 className="text-2xl font-bold tracking-[2px] md:text-3xl">{title}</h2>
      {href && (
        <svg
          className="h-5 w-5 opacity-70 transition-transform group-hover:translate-x-1"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path d="M9 5l7 7-7 7" />
        </svg>
      )}
    </div>
  );

  return (
    <div className="mb-10 flex flex-col items-center gap-4">
      {href ? (
        <Link href={href} className="text-vermilion transition-opacity hover:opacity-80">
          {TitleContent}
        </Link>
      ) : (
        <div className="text-ink">{TitleContent}</div>
      )}
      <p className="text-center text-base text-secondary">{subtitle}</p>
      {rule && <div className="h-0.5 w-10 bg-vermilion" />}
    </div>
  );
}
