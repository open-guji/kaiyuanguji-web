'use client';

import { useRouter } from 'next/navigation';
import { splitHighlightSnippet, useConvert, useT, type IndexEntry } from 'book-index-ui';
import styles from './SearchResultCard.module.css';

/**
 * 搜索结果卡片（传给 IndexBrowser 的 renderEntry，N3b）。
 *
 * 按新设计：整张卡是一个真链接（键盘可达、可长按新开）；不画边框，靠抬起的底色分组；
 * 朝代、作者、版本、类型写成小一号的辅助字、用「·」分隔；只有「有影印」用色块。
 * 地址仍是 /book-index?id=（静态站与全栈站都能开，全栈站由中间件 308 到 /item/<id>）。
 */

// 与 book-index-ui IndexBrowser 的「最近浏览」共用一份 localStorage，
// 自定义卡片不经过组件内部的点击处理，这里补记一笔，空搜索时的「最近浏览」才不断档。
const RECENT_KEY = 'bim-recent-ids';
const MAX_RECENT = 50;

function rememberRecent(id: string) {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        const list = (raw ? (JSON.parse(raw) as string[]) : []).filter((i) => i !== id);
        list.unshift(id);
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch { /* 隐私模式等：忽略 */ }
}

function isPlainLeftClick(e: React.MouseEvent) {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function entryHref(id: string) {
    return `/book-index?id=${encodeURIComponent(id)}`;
}

export default function SearchResultCard({ entry, query }: { entry: IndexEntry; query?: string }) {
    const router = useRouter();
    const t = useT();
    const { convert } = useConvert();

    const title = convert(entry.title || entry.primary_name || entry.id);
    const measure = entry.measure_info
        ? convert(entry.measure_info)
        : entry.juan_count ? `${entry.juan_count}${t.unit.juan}` : '';

    // 撰人一行：〔朝代〕作者 职任；人物则是生卒
    const yr = (n?: number) => (n == null ? '?' : n < 0 ? `前${-n}` : String(n));
    const byline = [
        entry.dynasty ? `〔${convert(entry.dynasty)}〕` : '',
        entry.author ? convert(entry.author) : '',
        entry.role && entry.role !== 'author' ? ` ${convert(entry.role)}` : '',
        entry.type === 'entity' && (entry.birth_year != null || entry.death_year != null)
            ? ` ${yr(entry.birth_year)}—${yr(entry.death_year)}` : '',
    ].join('').trim();

    // 辅助字一行：类型 · 刊刻朝代+版本 · 有文字
    const edition = [entry.era ? `〔${convert(entry.era)}〕` : '', entry.edition ? convert(entry.edition) : ''].join('');
    const meta = [
        t.indexType[entry.type],
        edition,
        entry.has_text ? convert('有文字') : '',
    ].filter(Boolean);

    const q = query?.trim().toLowerCase();
    const alias = q
        ? [...(entry.additional_titles || []), ...(entry.attached_texts || [])]
            .map((a) => (typeof a === 'string' ? a : (a as { book_title?: string })?.book_title || ''))
            .find((a) => a && a.toLowerCase().includes(q))
        : undefined;

    const href = entryHref(entry.id);

    return (
        <a
            href={href}
            className={`${styles.card} bim-result-card`}
            data-type={entry.type}
            onClick={(e) => {
                rememberRecent(entry.id);
                if (!isPlainLeftClick(e)) return;
                e.preventDefault();
                router.push(href);
            }}
        >
            <span className={styles.head}>
                <span className={styles.title}>{title}</span>
                {measure && <span className={styles.aux}>{measure}</span>}
                {entry.has_image && <span className={styles.flag}>{convert('有影印')}</span>}
            </span>
            {byline && <span className={styles.byline}>{byline}</span>}
            <span className={styles.aux}>
                {meta.map((m, i) => (
                    <span key={i}>{i > 0 && <span aria-hidden="true"> · </span>}{m}</span>
                ))}
            </span>
            {alias && <span className={styles.aux}>{t.search.alias}：{convert(alias)}</span>}
            {entry.descriptionSnippet && (
                <span className={styles.snippet}>
                    {splitHighlightSnippet(entry.descriptionSnippet).map((seg, i) => seg.marked
                        ? <mark key={i}>{convert(seg.text)}</mark>
                        : <span key={i}>{convert(seg.text)}</span>)}
                </span>
            )}
        </a>
    );
}
