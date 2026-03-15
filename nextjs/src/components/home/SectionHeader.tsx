import Link from 'next/link';

interface SectionHeaderProps {
  title: string;
  subtitle: string;
  href?: string;
}

export default function SectionHeader({ title, subtitle, href }: SectionHeaderProps) {
  const TitleContent = (
    <div className="flex items-center gap-2 group">
      <h2 className="text-2xl font-bold tracking-wide">
        {title}
      </h2>
      {href && (
        <svg
          className="w-5 h-5 opacity-70 group-hover:translate-x-1 transition-transform"
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
    <div className="flex flex-col items-center gap-4 mb-8">
      {href ? (
        <Link href={href} className="text-vermilion hover:opacity-80 transition-opacity">
          {TitleContent}
        </Link>
      ) : (
        <div className="text-ink">{TitleContent}</div>
      )}
      <p className="text-secondary text-base text-center">{subtitle}</p>
      <div className="w-10 h-0.5 bg-vermilion" />
    </div>
  );
}
