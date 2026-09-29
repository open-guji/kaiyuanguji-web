/**
 * overview#267：阅读页出处名首屏繁简一致。
 * 用真的 book-index-ui LocaleProvider（不 mock），因为要测的正是它「converter 异步才到」的行为。
 */
import { act, render, screen } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { LocaleProvider, useConvert } from 'book-index-ui';
import SyncLocaleProvider from '../SyncLocaleProvider';

function Probe({ text }: { text: string }) {
    const { convert } = useConvert();
    return <span data-testid="p">{convert(text)}</span>;
}

async function ssr(el: React.ReactElement): Promise<string> {
    const g = globalThis as { TextEncoder?: unknown; setImmediate?: unknown };
    g.TextEncoder ??= (await import('node:util')).TextEncoder;
    g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
    return renderToString(el);
}

beforeEach(() => { localStorage.clear(); });

describe('SyncLocaleProvider', () => {
    it('首帧（还没等任何异步）简体模式下就已转换；原生 LocaleProvider 首帧是原样繁体', () => {
        const first = jest.fn();
        function Capture({ text }: { text: string }) {
            const { convert } = useConvert();
            if (!first.mock.calls.length) first(convert(text));
            return null;
        }
        render(<SyncLocaleProvider><Capture text="維基文庫" /></SyncLocaleProvider>);
        expect(first).toHaveBeenCalledWith('维基文库');

        // 对照：不用本组件，首帧 converter 还是 null，原样返回（这就是要修的现象）
        const native = jest.fn();
        function CaptureNative({ text }: { text: string }) {
            const { convert } = useConvert();
            if (!native.mock.calls.length) native(convert(text));
            return null;
        }
        render(<LocaleProvider><CaptureNative text="維基文庫" /></LocaleProvider>);
        expect(native).toHaveBeenCalledWith('維基文庫');
    });

    it('服务端渲染的 HTML 里就是简体，水合不报不一致', async () => {
        const el = <SyncLocaleProvider><Probe text="維基文庫" /></SyncLocaleProvider>;
        const html = await ssr(el);
        expect(html).toContain('维基文库');
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.appendChild(host);
        const recoverable = jest.fn();
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        await act(async () => { hydrateRoot(host, el, { onRecoverableError: recoverable }); });
        expect(recoverable).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
        expect(host.textContent).toBe('维基文库');
        host.remove();
    });

    it('组件库自己的 converter 异步到了以后，结果不变（不抖）', async () => {
        render(<SyncLocaleProvider><Probe text="維基文庫 CC BY-SA 4.0" /></SyncLocaleProvider>);
        expect(screen.getByTestId('p')).toHaveTextContent('维基文库 CC BY-SA 4.0');
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(screen.getByTestId('p')).toHaveTextContent('维基文库 CC BY-SA 4.0');
    });

    it('繁体模式（读者选过繁体）不转换', async () => {
        localStorage.setItem('bim-locale', 'zh-Hant');
        render(<SyncLocaleProvider><Probe text="維基文庫" /></SyncLocaleProvider>);
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        expect(screen.getByTestId('p')).toHaveTextContent('維基文庫');
    });

    it('受控 locale=zh-Hant：不转换', () => {
        render(<SyncLocaleProvider locale="zh-Hant"><Probe text="維基文庫" /></SyncLocaleProvider>);
        expect(screen.getByTestId('p')).toHaveTextContent('維基文庫');
    });

    it('与组件库同一份保留名单：曹霑 整体不转', () => {
        render(<SyncLocaleProvider><Probe text="曹霑撰《紅樓夢》" /></SyncLocaleProvider>);
        expect(screen.getByTestId('p')).toHaveTextContent('曹霑撰《红楼梦》');
    });
});
