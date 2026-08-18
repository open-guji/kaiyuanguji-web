import Link from 'next/link';
import Image from 'next/image';

interface RoadmapCardProps {
  title: string;
  description: string;
  image: string;
  slug: string;
}

export default function RoadmapCard({ title, description, image, slug }: RoadmapCardProps) {
  return (
    <Link
      href={`/read/${slug}`}
      className="lift-card block h-full cursor-pointer overflow-hidden no-underline"
    >
      {/* 图片区 */}
      <div className="relative aspect-video overflow-hidden">
        <Image src={image} alt={title} fill className="object-cover" />
        {/* 渐隐到卡片底色，衔接下方文字 */}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[var(--color-surface)]/20 to-[var(--color-surface)]" />
      </div>

      {/* 内容区 */}
      <div className="p-5 text-center">
        <h3 className="mb-2 text-lg font-semibold text-ink">{title}</h3>
        <p className="text-sm leading-relaxed text-secondary">{description}</p>
      </div>
    </Link>
  );
}
