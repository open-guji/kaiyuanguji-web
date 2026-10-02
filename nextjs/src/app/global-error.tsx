'use client';

// 根布局本身出错时的兜底（overview#322）。替换整个 <html>，拿不到站点外壳与多语言，文案写死简体。
// 自动重试的规则与 app/error.tsx 相同（lib/auto-retry.ts）。
import { useEffect, useState } from 'react';
import { reportError } from '@/lib/error-report';
import { reloadPage, shouldAutoRetry, type RetryableError } from '@/lib/auto-retry';

export default function GlobalError({ error }: { error: RetryableError; reset: () => void }) {
    const [retrying, setRetrying] = useState(true);

    useEffect(() => {
        const auto = shouldAutoRetry(error);
        reportError({
            kind: 'react',
            message: `[global] ${error.message || error.name || 'Error'}${error.digest ? ` (digest ${error.digest})` : ''}${auto ? '（已自动重新加载）' : ''}`,
            stack: error.stack,
        });
        if (auto) {
            reloadPage();
            return;
        }
        setRetrying(false);
    }, [error]);

    return (
        <html lang="zh-CN">
            <body style={{ margin: 0, background: '#faf7f2', color: '#26211c', fontFamily: 'system-ui, sans-serif' }}>
                {!retrying && (
                    <div role="alert" style={{ maxWidth: 560, margin: '0 auto', padding: '80px 20px', textAlign: 'center' }}>
                        <h1 style={{ fontSize: '1.5rem', marginBottom: 12 }}>页面没能打开</h1>
                        <p style={{ lineHeight: 1.7, marginBottom: 32 }}>多半是网络一时不通。刷新一下通常就好；还不行，请稍后再来。</p>
                        <button
                            type="button"
                            onClick={() => reloadPage()}
                            style={{ background: '#9e2a2b', color: '#fff', border: 0, borderRadius: 4, padding: '10px 24px', fontSize: '1rem', cursor: 'pointer' }}
                        >
                            刷新页面
                        </button>
                        <p style={{ marginTop: 24 }}><a href="/" style={{ color: '#9e2a2b' }}>回首页</a></p>
                    </div>
                )}
            </body>
        </html>
    );
}
