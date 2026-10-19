'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFulltext, fetchFulltextStatus } from '@/lib/fulltext/fulltext-client';
import type { FulltextError, FulltextResponse } from '@/lib/fulltext/fulltext-client';
import FulltextResults from './FulltextResults';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 构建期开关：NEXT_PUBLIC_FULLTEXT_TAB=1 才可能渲染「全文」tab，默认关。它是总闸，改它要重新构建发布。
 * 运行时开关（不用重新构建）：总闸开着时，挂载先查 `/api/fulltext?op=status`（边缘函数读 COS 上的开关文件），
 * `enabled` 为真才显示 tab；查不到也不显示。搜索时边缘函数回 503 `disabled`（开关刚关）也立刻隐藏。
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
    const buildEnabled = isFulltextEnabled();
    // 运行时开关：null＝还在查；查完 true／false
    const [live, setLive] = useState<boolean | null>(null);
    const [data, setData] = useState<FulltextResponse | null>(null);
    const [error, setError] = useState<FulltextError | null>(null);
    const [loading, setLoading] = useState(false);
    const seq = useRef(0);

    useEffect(() => {
        if (!buildEnabled) return;
        let cancelled = false;
        void fetchFulltextStatus({ fetchImpl }).then((s) => { if (!cancelled) setLive(s.enabled); });
        return () => { cancelled = true; };
    }, [buildEnabled, fetchImpl]);

    const run = useCallback(async (offset: number) => {
        const my = ++seq.current;
        setLoading(true);
        const r = await fetchFulltext({ q, offset }, { fetchImpl });
        if (my !== seq.current) return; // 过期响应丢弃
        setLoading(false);
        if (!r.ok) {
            if (r.kind === 'disabled') { setLive(false); return; } // 开关刚关：入口立刻收起
            setError(r);
            return;
        }
        setError(null);
        setData((prev) => (offset > 0 && prev ? { ...r.data, groups: [...prev.groups, ...r.data.groups] } : r.data));
    }, [q, fetchImpl]);

    const enabled = buildEnabled && live === true;
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
