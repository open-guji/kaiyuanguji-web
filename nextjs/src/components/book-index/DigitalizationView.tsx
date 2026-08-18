'use client';

import { useState, useEffect, useRef } from 'react';
import { DigitalAssets } from '@/types';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

interface DigitalizationViewProps {
    id: string;
    assets: DigitalAssets;
    initialPage?: number;
}

export default function DigitalizationView({ id, assets, initialPage = 1 }: DigitalizationViewProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();

    const [texSource, setTexSource] = useState<string>('');
    const [imageManifest, setImageManifest] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [renderStatus, setRenderStatus] = useState<string>('等待数据...');
    const viewerRef = useRef<HTMLDivElement>(null);
    const renderContainerRef = useRef<HTMLDivElement>(null);
    const scaleWrapperRef = useRef<HTMLDivElement>(null);
    const imagesRef = useRef<HTMLDivElement>(null);

    // Pagination state
    const [pageTex, setPageTex] = useState(initialPage);
    const [pageImages, setPageImages] = useState(initialPage);
    const [isSynced, setIsSynced] = useState(true);
    const [texTotal, setTexTotal] = useState(0);
    const [imagesTotal, setImagesTotal] = useState(0);
    const [webtexVersion, setWebtexVersion] = useState<string>('');

    const isLocal = process.env.NEXT_PUBLIC_MODE === 'local';


    // Panel visibility: which of the 3 panels are shown
    const [panels, setPanels] = useState({
        tex: true,
        render: true,
        images: true,
    });

    const togglePanel = (key: 'tex' | 'render' | 'images') => {
        setPanels(prev => {
            // Don't allow hiding all panels
            const next = { ...prev, [key]: !prev[key] };
            if (!next.tex && !next.render && !next.images) return prev;
            return next;
        });
    };

    const visibleCount = [panels.tex, panels.render, panels.images].filter(Boolean).length;

    // Load assets
    useEffect(() => {
        const loadAssets = async () => {
            try {
                setIsLoading(true);
                const basePath = assets.image_manifest_url?.replace(/\/images\/image_manifest\.json$/, '') || `/books/${id}`;

                if (assets.tex_files && assets.tex_files.length > 0) {
                    const texUrl = `${basePath}/tex/${assets.tex_files[0]}`;
                    setRenderStatus(`正在获取: ${texUrl}`);
                    const res = await fetch(texUrl);
                    if (res.ok) {
                        const text = await res.text();
                        setTexSource(text);
                        setRenderStatus(`获取成功, ${text.length} 字符`);
                    } else {
                        setRenderStatus(`获取失败: HTTP ${res.status}`);
                    }
                } else {
                    setRenderStatus('无 TeX 文件');
                }

                if (assets.image_manifest_url) {
                    const res = await fetch(assets.image_manifest_url);
                    if (res.ok) {
                        const data = await res.json();
                        setImageManifest(data);
                    }
                }
            } catch (error) {
                console.error('Failed to load digital assets:', error);
                setRenderStatus(`加载失败: ${error}`);
            } finally {
                setIsLoading(false);
            }
        };

        loadAssets();
    }, [id, assets]);

    // Render WebTeX — depends on both texSource AND isLoading,
    // because the viewerRef div only exists when isLoading is false.
    useEffect(() => {
        if (isLoading || !texSource) {
            return;
        }
        if (!viewerRef.current) {
            setRenderStatus('viewerRef 未挂载');
            return;
        }

        setRenderStatus('正在加载 webtex-cn 库...');

        const renderTex = async () => {
            try {
                // Ensure base.css is loaded
                if (!document.querySelector('link[href="/webtex-css/base.css"]')) {
                    const baseLink = document.createElement('link');
                    baseLink.rel = 'stylesheet';
                    baseLink.href = '/webtex-css/base.css';
                    document.head.appendChild(baseLink);
                }

                const mod = await import('webtex-cn');
                // Handle both ES modules and transpiled CJS (default wrapper)
                const webtex = (mod as any).default || mod;

                // Try to get version from the package or use the known current version
                // Since webtex-cn doesn't export it yet, we use the one from its package.json
                setWebtexVersion('0.1.2');

                if (!webtex || typeof webtex.renderToDOM !== 'function') {
                    setRenderStatus('模块加载失败: renderToDOM 不存在');
                    return;
                }

                setRenderStatus('正在排版...');

                if (viewerRef.current) {
                    webtex.renderToDOM(texSource, viewerRef.current, {
                        cssBasePath: '/webtex-css/'
                    });

                    // Find all rendered pages and configure
                    const pages = viewerRef.current.querySelectorAll('.wtc-page');
                    setTexTotal(pages.length);
                    pages.forEach((page: any, idx: number) => {
                        page.style.margin = '0 auto';
                        page.style.padding = '0';
                        // Show only active page
                        page.style.display = (idx + 1 === pageTex) ? 'block' : 'none';
                    });

                    // After render, wait for layout to complete then measure & scale
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            applyScale();
                        });
                    });

                    const count = viewerRef.current.children.length;
                    setRenderStatus(`排版完成, ${count} 个元素`);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                setRenderStatus(`排版失败: ${msg}`);
                console.error('[DigitalizationView] Render error:', error);
            }
        };

        renderTex();
    }, [texSource, isLoading, pageTex]);

    // Direct DOM scaling — no React state, no stale closures
    const applyScale = () => {
        const container = renderContainerRef.current;
        const wrapper = scaleWrapperRef.current;
        const viewer = viewerRef.current;
        if (!container || !wrapper || !viewer) return;

        // Temporarily reset transform to measure natural content size
        wrapper.style.transform = 'translateX(-50%) scale(1)';

        // Find the currently visible .wtc-page
        const visiblePage = viewer.querySelector('.wtc-page') as HTMLElement;
        if (!visiblePage) return;

        const containerW = container.clientWidth;
        const containerH = container.clientHeight;
        const contentW = visiblePage.offsetWidth;
        const contentH = visiblePage.offsetHeight;

        if (contentW === 0 || contentH === 0) return;

        const scaleW = containerW / contentW;
        const scaleH = containerH / contentH;
        const s = Math.min(scaleW, scaleH, 1.5);
        const finalScale = Math.max(s, 0.1);

        // Apply the computed scale directly to the DOM
        wrapper.style.transform = `translateX(-50%) scale(${finalScale})`;
    };

    // Resize handling for responsive scaling — uses direct DOM, no closure issues
    useEffect(() => {
        const container = renderContainerRef.current;
        if (!container) return;

        const observer = new ResizeObserver(() => {
            applyScale();
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, []);

    // Update images total when manifest changes
    useEffect(() => {
        if (imageManifest?.volumes?.[0]?.files) {
            setImagesTotal(imageManifest.volumes[0].files.length);
        }
    }, [imageManifest]);

    // Navigation handlers
    const goToPage = (view: 'tex' | 'images', newPage: number) => {
        const total = view === 'tex' ? texTotal : imagesTotal;
        const boundedPage = Math.max(1, Math.min(newPage, total));

        if (isSynced) {
            setPageTex(boundedPage);
            setPageImages(boundedPage);
        } else {
            if (view === 'tex') setPageTex(boundedPage);
            else setPageImages(boundedPage);
        }
    };

    // Update URL when page changes
    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());
        // We use pageTex as the primary "page" for the URL if synced
        const currentPage = isSynced ? pageTex : pageTex;
        if (currentPage !== parseInt(searchParams.get('page') || '0')) {
            params.set('page', currentPage.toString());
            router.replace(`${pathname}?${params.toString()}`, { scroll: false });
        }
    }, [pageTex, isSynced, pathname, router, searchParams]);


    if (isLoading) {
        return <div className="p-8 text-center text-secondary">加载数字化资源中...</div>;
    }

    const basePath = assets.image_manifest_url?.replace(/\/images\/image_manifest\.json$/, '') || `/books/${id}`;

    return (
        <div className="flex flex-col h-[calc(100vh-140px)] mt-4">
            {/* 面板开关：设计稿的「签条」样式 */}
            <div className="mb-3 flex items-center justify-center gap-2 px-1">
                {[
                    { key: 'tex' as const, label: 'TeX 源码', icon: '{ }' },
                    { key: 'render' as const, label: '排版预览', icon: '◫' },
                    { key: 'images' as const, label: '影印影像', icon: '🖼' },
                ].map(({ key, label, icon }) => (
                    <button
                        key={key}
                        onClick={() => togglePanel(key)}
                        aria-pressed={panels[key]}
                        className={`flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-3.5 py-1.5 text-xs font-medium transition-all
                            ${panels[key]
                                ? 'border-vermilion/40 bg-[color-mix(in_srgb,var(--color-vermilion)_10%,transparent)] text-vermilion'
                                : 'border-border/50 bg-surface text-secondary hover:border-vermilion/30 hover:text-vermilion'
                            }`}
                    >
                        <span className="text-[11px]">{icon}</span>
                        {label}
                    </button>
                ))}
            </div>

            {/* Panel grid — use CSS display to hide panels so DOM content is preserved */}
            <div className="grid gap-4 h-full pb-4 transition-all duration-300" style={{ gridTemplateColumns: `repeat(${visibleCount}, 1fr)` }}>
                {/* Column 1: TeX Source */}
                <div className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border/60 bg-surface shadow-[var(--shadow-soft)]" style={{ display: panels.tex ? undefined : 'none' }}>
                    <div className="bg-paper border-b border-border/60 px-4 py-2.5 text-xs font-bold text-secondary uppercase tracking-widest flex items-center justify-between">
                        <span>TeX 源码</span>
                        <span className="text-[10px] opacity-50 font-mono">{assets.tex_files?.[0]}</span>
                    </div>
                    <pre className="flex-1 overflow-auto p-5 text-sm font-mono text-ink leading-relaxed selection:bg-vermilion/10">
                        {texSource || '无 TeX 源码'}
                    </pre>
                </div>

                {/* Column 2: Rendered View */}
                <div className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border/60 bg-surface shadow-[var(--shadow-soft)]" style={{ display: panels.render ? undefined : 'none' }}>
                    <div className="bg-paper border-b border-border/60 px-4 py-2.5 text-xs font-bold text-secondary uppercase tracking-widest flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span>WebTeX 排版</span>
                            {webtexVersion && (
                                <span className="bg-ink/5 px-1.5 py-0.5 rounded text-[9px] font-mono text-secondary/60">
                                    v{webtexVersion}
                                </span>
                            )}
                            {isLocal && (
                                <span className="bg-vermilion/5 text-vermilion px-1.5 py-0.5 rounded text-[9px]">
                                    LOCAL
                                </span>
                            )}
                        </div>
                        <span className="text-[10px] text-vermilion font-mono">{renderStatus}</span>
                    </div>
                    <div
                        ref={renderContainerRef}
                        className="relative flex-1 overflow-hidden bg-paper"
                    >
                        <div
                            ref={scaleWrapperRef}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: '50%',
                                transform: 'translateX(-50%) scale(1)',
                                transformOrigin: 'top center',
                            }}
                        >
                            <div
                                ref={viewerRef}
                                className="wtc-scope"
                            />
                        </div>
                    </div>
                </div>

                {/* Column 3: Images */}
                <div className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-border/60 bg-surface shadow-[var(--shadow-soft)]" style={{ display: panels.images ? undefined : 'none' }}>
                    <div className="bg-paper border-b border-border/60 px-4 py-2.5 text-xs font-bold text-secondary uppercase tracking-widest">
                        影印本影像
                    </div>
                    <div
                        ref={imagesRef}
                        className="flex-1 overflow-hidden bg-paper"
                    >
                        <div className="flex flex-col items-center justify-center h-full overflow-auto">
                            {imageManifest?.volumes?.[0]?.files?.[pageImages - 1] && (
                                <div
                                    className="flex flex-col items-center justify-center bg-surface"
                                    style={{
                                        height: '100%',
                                        width: '100%',
                                        flexShrink: 0
                                    }}
                                >
                                    <div className="relative w-full h-full overflow-hidden flex items-center justify-center p-2">
                                        <img
                                            src={`${basePath}/images/vol01/${imageManifest.volumes[0].files[pageImages - 1].filename}`}
                                            alt={`Page ${pageImages}`}
                                            className="max-w-full max-h-full object-contain shadow-lg border border-border/40"
                                            loading="lazy"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                        {!imageManifest && <div className="text-sm text-secondary p-4 text-center">无影像资源</div>}
                    </div>
                </div>
            </div>

            {/* Pagination Control Bar */}
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 rounded-[var(--radius-card)] border border-border/60 bg-surface px-4 py-3 shadow-[var(--shadow-soft)]">
                {/* Tex Controls */}
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-secondary uppercase tracking-widest mr-2">排版</span>
                    <button
                        onClick={() => goToPage('tex', pageTex - 1)}
                        disabled={pageTex <= 1}
                        className="rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 transition-colors hover:border-vermilion/40 hover:text-vermilion disabled:opacity-30 disabled:hover:border-border/60 disabled:hover:text-inherit"
                    >
                        ←
                    </button>
                    <div className="flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 font-mono text-sm">
                        <input
                            type="number"
                            value={pageTex}
                            onChange={(e) => goToPage('tex', parseInt(e.target.value) || 1)}
                            className="w-10 text-center bg-transparent border-none outline-none focus:ring-0"
                        />
                        <span className="text-secondary/40">/</span>
                        <span className="text-secondary/60">{texTotal}</span>
                    </div>
                    <button
                        onClick={() => goToPage('tex', pageTex + 1)}
                        disabled={pageTex >= texTotal}
                        className="rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 transition-colors hover:border-vermilion/40 hover:text-vermilion disabled:opacity-30 disabled:hover:border-border/60 disabled:hover:text-inherit"
                    >
                        →
                    </button>
                </div>

                {/* Sync Toggle */}
                <button
                    onClick={() => {
                        const next = !isSynced;
                        setIsSynced(next);
                        if (next) setPageImages(pageTex);
                    }}
                    className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all border
                        ${isSynced
                            ? 'bg-vermilion/10 text-vermilion border-vermilion/30 shadow-sm'
                            : 'bg-paper text-secondary border-border/60'}`}
                >
                    <span className="text-sm">{isSynced ? '🔒' : '🔓'}</span>
                    同步锁定
                </button>

                {/* Image Controls */}
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-secondary uppercase tracking-widest mr-2">影像</span>
                    <button
                        onClick={() => goToPage('images', pageImages - 1)}
                        disabled={pageImages <= 1}
                        className="rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 transition-colors hover:border-vermilion/40 hover:text-vermilion disabled:opacity-30 disabled:hover:border-border/60 disabled:hover:text-inherit"
                    >
                        ←
                    </button>
                    <div className="flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 font-mono text-sm">
                        <input
                            type="number"
                            value={pageImages}
                            onChange={(e) => goToPage('images', parseInt(e.target.value) || 1)}
                            className="w-10 text-center bg-transparent border-none outline-none focus:ring-0"
                        />
                        <span className="text-secondary/40">/</span>
                        <span className="text-secondary/60">{imagesTotal}</span>
                    </div>
                    <button
                        onClick={() => goToPage('images', pageImages + 1)}
                        disabled={pageImages >= imagesTotal}
                        className="rounded-[var(--radius-pill)] border border-border/60 bg-paper px-2 py-1 transition-colors hover:border-vermilion/40 hover:text-vermilion disabled:opacity-30 disabled:hover:border-border/60 disabled:hover:text-inherit"
                    >
                        →
                    </button>
                </div>
            </div>
        </div>
    );
}

