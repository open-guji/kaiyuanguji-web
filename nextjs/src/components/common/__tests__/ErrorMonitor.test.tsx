import { render } from '@testing-library/react';
import ErrorMonitor from '../ErrorMonitor';
import * as report from '../../../lib/error-report';

jest.mock('../../../lib/error-report', () => ({
    reportError: jest.fn(),
}));

describe('ErrorMonitor chunk reload (15 甲类)', () => {
    const reloadMock = jest.fn();
    let originalReload: () => void;

    beforeEach(() => {
        jest.clearAllMocks();
        sessionStorage.clear();
        // jsdom 的 location.reload 不可直接 mock，改用 getter
        originalReload = window.location.reload;
        Object.defineProperty(window, 'location', {
            value: { ...window.location, reload: reloadMock },
            writable: true,
        });
    });

    afterEach(() => {
        Object.defineProperty(window, 'location', {
            value: { ...window.location, reload: originalReload },
            writable: true,
        });
    });

    it('chunk 资源 404 时触发一次 reload 并上报', () => {
        render(<ErrorMonitor />);
        const script = document.createElement('script');
        script.src = 'https://www.kaiyuanguji.com/_next/static/chunks/636-1d1a429932ba7508.js';
        const event = new Event('error', { bubbles: true }) as ErrorEvent;
        Object.defineProperty(event, 'target', { value: script, writable: false });
        window.dispatchEvent(event);
        expect(reloadMock).toHaveBeenCalledTimes(1);
        expect((report as unknown as { reportError: jest.Mock }).reportError).toHaveBeenCalledWith(
            expect.objectContaining({ resource: expect.stringContaining('/_next/static/') }),
        );
    });

    it('60 秒内第二次 chunk 失败不再 reload（防循环），60 秒后可再触发', () => {
        render(<ErrorMonitor />);
        sessionStorage.setItem('chunk-reload-attempted-at', String(Date.now()));
        const script = document.createElement('script');
        script.src = 'https://www.kaiyuanguji.com/_next/static/chunks/636-1d1a429932ba7508.js';
        const event = new Event('error', { bubbles: true }) as ErrorEvent;
        Object.defineProperty(event, 'target', { value: script, writable: false });
        window.dispatchEvent(event);
        expect(reloadMock).not.toHaveBeenCalled();
        // 60 秒后可再触发
        sessionStorage.setItem('chunk-reload-attempted-at', String(Date.now() - 61_000));
        const script2 = document.createElement('script');
        script2.src = 'https://www.kaiyuanguji.com/_next/static/chunks/636-1d1a429932ba7508.js';
        const event2 = new Event('error', { bubbles: true }) as ErrorEvent;
        Object.defineProperty(event2, 'target', { value: script2, writable: false });
        window.dispatchEvent(event2);
        expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('非 chunk 图片失败不触发 reload', () => {
        render(<ErrorMonitor />);
        const img = document.createElement('img');
        // @ts-expect-error jsdom img src
        img.src = '/images/open-guji-logo.webp';
        const event = new Event('error', { bubbles: true }) as ErrorEvent;
        Object.defineProperty(event, 'target', { value: img, writable: false });
        window.dispatchEvent(event);
        expect(reloadMock).not.toHaveBeenCalled();
    });
});
