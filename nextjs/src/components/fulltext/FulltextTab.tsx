'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFulltext } from '@/lib/fulltext/fulltext-client';
import type { FulltextError, FulltextResponse } from '@/lib/fulltext/fulltext-client';
import FulltextResults from './FulltextResults';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 构建期开关：NEXT_PUBLIC_FULLTEXT_TAB=1 才渲染「全文」tab，默认关。
 * 注意是构建期值，改它要重新构建发布；即时降级靠服务端 FULLTEXT_ENABLED（F5）返回 503 → 本组件显示“暂不可用”。
 */
export function isFulltextEnabled(): boolean {
    return process.env.NEXT_PUBLIC_FULLTEXT_TAB === '1';
}

interface Props {
    q: string;
    fetchImpl?: typeof fetch;
}

export default function FulltextTab({ q, fetchImpl }: Props) {
    const t = useSiteT();
    const enabled = isFulltextEnabled();
    const [data, setData] = useState<FulltextResponse | null>(null);
    const [error, setError] = useState<FulltextError | null>(null);
    const [loading, setLoading] = useState(false);
    const seq = useRef(0);

    const run = useCallback(async (offset: number) => {
        const my = ++seq.current;
        setLoading(true);
        const r = await fetchFulltext({ q, offset }, { fetchImpl });
        if (my !== seq.current) return; // 过期响应丢弃
        setLoading(false);
        if (!r.ok) { setError(r); return; }
        setError(null);
        setData((prev) => (offset > 0 && prev ? { ...r.data, groups: [...prev.groups, ...r.data.groups] } : r.data));
    }, [q, fetchImpl]);

    useEffect(() => {
        if (!enabled || !q.trim()) return;
        setData(null);
        setError(null);
        void run(0);
    }, [enabled, q, run]);

    if (!enabled) return null;
    return (
        <div>
            <div role="tablist"><button role="tab" aria-selected="true" type="button">{t('bookIndex.fulltext.tab')}</button></div>
            <div role="tabpanel">
                <FulltextResults data={data} error={error} loading={loading} onLoadMore={() => void run(data?.groups.length ?? 0)} />
            </div>
        </div>
    );
}
