'use client';

import { useEffect, useState, type RefObject } from 'react';

export interface ReaderLeadData {
    paragraphs: string[];
    truncated: boolean;
    /** 本章规范地址，「继续阅读」指向它自己 */
    selfHref: string;
    prev?: { href: string; label: string };
    next?: { href: string; label: string };
    /** 书目页 /item/<id> */
    itemHref: string;
    itemLabel: string;
}

/**
 * 服务端直出的首章正文（overview#581 方案 A 第 3 项，过渡做法，待 book-index-ui 的 initialChapter 替换）：
 * 爬虫拿到的 HTML 里有读者首屏同一章的正文与上下章真链接。放在阅读器之前（流内）：水合前独占首屏，阅读器壳挂在它下面不挤它；卸载时阅读器本在首屏外，随后长出正文，不记位移（GUJI-181，实测前后各 ≥5 次见 overview 产出文件）。
 * 挂载状态由 React 管：初始渲染＝显示，与服务端一致（水合安全）；阅读器自己的内容长出来后再卸载。
 * 不用 display:none 留着，也不在 effect 里手动删 DOM。
 */
export default function ReaderLead({ data, hostRef }: { data: ReaderLeadData; hostRef: RefObject<HTMLElement | null> }) {
    const [shown, setShown] = useState(true);
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const lead = host.querySelector('[data-reader-lead]');
        const readerLen = () => (host.textContent?.length ?? 0) - (lead?.textContent?.length ?? 0);
        const baseline = readerLen();
        const done = () => setShown(false);
        const check = () => { if (readerLen() - baseline > 200) done(); };
        const mo = new MutationObserver(check);
        mo.observe(host, { childList: true, subtree: true, characterData: true });
        // 阅读器取数失败或正文很短（达不到阈值）也不一直留着
        const timer = window.setTimeout(done, 10_000);
        check();
        return () => { mo.disconnect(); window.clearTimeout(timer); };
    }, [hostRef]);
    if (!shown) return null;
    return (
        <section data-reader-lead className="mx-auto max-w-3xl px-4 py-6 leading-8">
            {data.paragraphs.map((p, i) => <p key={i} className="mb-4">{p}</p>)}
            {data.truncated && <p><a href={data.selfHref}>继续阅读</a></p>}
            <nav className="mt-4 flex flex-wrap gap-4 text-sm">
                {data.prev && <a href={data.prev.href} rel="prev">上一章：{data.prev.label}</a>}
                {data.next && <a href={data.next.href} rel="next">下一章：{data.next.label}</a>}
                <a href={data.itemHref}>{data.itemLabel}</a>
            </nav>
        </section>
    );
}
