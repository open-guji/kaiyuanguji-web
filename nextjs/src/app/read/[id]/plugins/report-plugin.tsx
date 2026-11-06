import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { loadReaderFiles, type ReaderApi, type ReaderPlugin } from 'book-index-ui';
import CharFixEntry from '@/components/CharFixEntry';
import SpanFixDialog from '@/components/SpanFixDialog';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteT } from '@/i18n/translate';
import type { FeedbackContext } from '@/lib/feedback';
import { canFixChar, collectEntities, entityFileVersion, spanOfAnchors, VERSION_RE, type CharFixCtx, type CharFixEntity, type SpanSel } from '@/lib/charfix';
import { TEXT_FILE_BASE } from '@/lib/text-file';

const ID = 'kyg:report';

/** 本章取到的改字材料（不含逐字表：那个由阅读器的 api.cells 给） */
interface ReportChapter {
    book: string;
    volume: string;
    chapter: string;
    textVersion: string;
    entities: CharFixEntity[];
    entityVersion: string;
    /** api.cells → 格位到原字，按 cells 引用缓存 */
    chars?: { cells: ReaderApi['cells']; map: Map<string, string> };
}

interface Snap {
    /** 点字浮条（改字入口） */
    bar: { cell: string; rect: DOMRect } | null;
    /** 「这段有问题」弹窗 */
    spanFix: { ctx: CharFixCtx; span: SpanSel } | null;
    /** 「复制」已点的那次选区（换选区后恢复） */
    copied: string | null;
}

function createStore() {
    let snap: Snap = { bar: null, spanFix: null, copied: null };
    const subs = new Set<() => void>();
    return {
        get: () => snap,
        subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
        patch(p: Partial<Snap>) { snap = { ...snap, ...p }; subs.forEach(f => f()); },
    };
}

export interface ReportPluginOpts {
    /** 本页反馈上下文（书名 · 版本 · 章）；换章后会变，所以给取值函数 */
    getFeedbackContext: () => FeedbackContext;
    /** 打开通用反馈弹窗 */
    openFeedback: (a: { context: FeedbackContext; type: 'bug' }) => void;
    /** 站点文案（selectionActions 在 React 之外调用，拿不到 hook） */
    getT: () => SiteT;
    /** 测试注入 */
    fetchImpl?: typeof fetch;
}

/** 选中的格位 → 本章改字上下文（含逐字表）；本章没有对读数据返回 null */
function ctxOf(api: ReaderApi): CharFixCtx | null {
    const st = api.state<ReportChapter>(ID);
    if (!st) return null;
    if (!st.chars || st.chars.cells !== api.cells) st.chars = { cells: api.cells, map: new Map(api.cells.map(c => [c.anchor, c.char])) };
    return { book: st.book, volume: st.volume, chapter: st.chapter, textVersion: st.textVersion, chars: st.chars.map, entities: st.entities, entityVersion: st.entityVersion };
}

/**
 * 选字「复制 ｜ 報錯」与点字「改字／專名有誤」，作为阅读器插件：
 *   onChapter 取本章的文本版本与专名层；selectionActions 出浮条按钮；onCell.click 出点字浮条；overlay 放浮条与弹窗。
 * 不再监听 document 选区、不再用 closest('[data-char-id]')：选了哪些格、点了哪个字都由阅读器接口给。
 */
export function reportPlugin(o: ReportPluginOpts): ReaderPlugin {
    const store = createStore();
    return {
        id: ID,
        async onChapter(ctx) {
            const files = await loadReaderFiles(
                ctx.transport as never,
                { id: ctx.entryId, versionKey: ctx.versionKey, chapter: ctx.chapter as unknown as Record<string, unknown> },
                { cord: ctx.viewport === 'wide', textFileBase: TEXT_FILE_BASE },
            );
            if (!files?.char) return undefined;
            const chapter = ctx.chapter as unknown as { file?: string; text_version?: unknown; entity_version?: unknown };
            // 文本版本：章条目的 text_version，缺则 char.json 的 version；两处都没有（或不合口径）就是空串——不猜，改字入口照出但不收（浮条里说明）
            const textVersion = [chapter.text_version, (files.char as { version?: unknown } | null)?.version]
                .map(v => (v === undefined || v === null ? '' : String(v)))
                .find(v => VERSION_RE.test(v)) ?? '';
            const declared = chapter.entity_version;
            const st: ReportChapter = {
                book: ctx.entryId,
                volume: String(chapter.file ?? ctx.chapterKey),
                chapter: String(ctx.chapterKey),
                textVersion,
                entities: collectEntities(files.entity),
                entityVersion: typeof declared === 'string' && VERSION_RE.test(declared) ? declared : entityFileVersion(files.entity),
            };
            return st;
        },
        selectionActions(sel, api) {
            const t = o.getT();
            const key = `${sel.anchors[0]}|${sel.anchors.length}`;
            const copied = store.get().copied === key;
            return [
                {
                    key: 'copy',
                    label: copied ? t('feedback.selection.copied') : t('feedback.selection.copy'),
                    onClick: () => {
                        // 复制按阅读顺序拼起来的字（经繁简偏好转换，同屏上看到的一致）；不受浮条里 500 字的截断
                        const all = sel.anchors.length > 0 ? api.convert(api.cells.filter(c => sel.anchors.includes(c.anchor)).map(c => c.char).join('')) : sel.text;
                        navigator.clipboard?.writeText(all).then(() => { store.patch({ copied: key }); api.refresh(); }, () => { /* 没给剪贴板权限就算了，系统菜单里还能复制 */ });
                    },
                },
                {
                    key: 'report',
                    label: t('feedback.selection.report'),
                    onClick: () => {
                        const ctx = ctxOf(api);
                        const span = ctx && canFixChar(ctx) ? spanOfAnchors(sel.anchors, ctx.chars) : null;
                        if (ctx && span) store.patch({ spanFix: { ctx, span } });
                        else o.openFeedback({ context: { ...o.getFeedbackContext(), quote: sel.text }, type: 'bug' });
                    },
                },
            ];
        },
        onCell: {
            click(hit, api) {
                if (!ctxOf(api) || !hit.rect) { store.patch({ bar: null }); return; }
                store.patch({ bar: { cell: hit.anchor, rect: hit.rect } });
            },
        },
        overlay: (api) => <ReportLayer api={api} store={store} fetchImpl={o.fetchImpl} />,
    };
}

function ReportLayer({ api, store, fetchImpl }: { api: ReaderApi; store: ReturnType<typeof createStore>; fetchImpl?: typeof fetch }) {
    const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
    const t = useSiteT();
    // 换章：点字浮条不跨章保留
    useEffect(() => { store.patch({ bar: null }); }, [api.ctx.chapterKey, store]);
    const ctx = ctxOf(api);
    if (typeof document === 'undefined') return null;
    return createPortal(
        <>
            {snap.bar && ctx && <CharFixEntry target={snap.bar} ctx={ctx} fetchImpl={fetchImpl} onClose={() => store.patch({ bar: null })} />}
            {snap.spanFix && <SpanFixDialog t={t} ctx={snap.spanFix.ctx} span={snap.spanFix.span} fetchImpl={fetchImpl} onClose={() => store.patch({ spanFix: null })} />}
        </>,
        document.body,
    );
}
