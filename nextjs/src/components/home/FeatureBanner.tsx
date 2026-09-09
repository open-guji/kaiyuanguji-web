import { Fragment } from 'react';
import Image from 'next/image';

interface FeatureBannerProps {
  /** 小标签，如「竖排排版 · 版心装饰 · 夹注侧批」 */
  tags: React.ReactNode[];
  title: string;
  description: string;
  /** 右侧配图；不传则只有文字 */
  image?: { src: string; alt: string };
  /** 主按钮；不传则渲染 disabled 的占位按钮 */
  action?: { label: string; href: string; external?: boolean };
  /** 无 action 时显示的禁用态文案 */
  disabledLabel?: string;
  children?: React.ReactNode;
}

export default function FeatureBanner({
  tags,
  title,
  description,
  image,
  action,
  disabledLabel,
  children,
}: FeatureBannerProps) {
  return (
    <div className="feature-card reveal mb-10 flex flex-wrap items-center gap-8 p-10">
      {/* 左：文字 */}
      <div className="min-w-[300px] flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-vermilion">
          {tags.map((tag, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden="true">·</span>}
              {/* 包一层，保证纯字符串标签也是 flex item（否则 gap 不生效） */}
              <span>{tag}</span>
            </Fragment>
          ))}
        </div>

        <h3 className="mb-4 text-2xl font-semibold text-ink md:text-3xl">{title}</h3>

        <p className="mb-6 text-base leading-loose text-secondary md:text-lg">
          {description}
        </p>

        {children}

        {action ? (
          <a
            href={action.href}
            {...(action.external
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
            className="inline-flex items-center rounded-lg bg-vermilion px-7 py-3
                       font-medium text-white no-underline transition-colors
                       hover:bg-vermilion-deep hover:no-underline"
          >
            {action.label}
          </a>
        ) : (
          <button
            disabled
            className="cursor-not-allowed rounded-lg border border-border bg-paper
                       px-7 py-3 font-medium text-secondary"
          >
            {disabledLabel ?? '开发中'}
          </button>
        )}
      </div>

      {/* 右：配图 */}
      {image && (
        <div
          className="relative h-[220px] w-full overflow-hidden rounded-xl border border-border
                     shadow-[var(--shadow-soft)] md:w-[340px] md:flex-none"
        >
          <Image
            src={image.src}
            alt={image.alt}
            fill
            sizes="(max-width: 900px) 100vw, 340px"
            className="object-cover"
            style={{ filter: 'sepia(0.15)' }}
          />
        </div>
      )}
    </div>
  );
}
