import { useContext } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LocaleContext } from 'book-index-ui';
import BimLocaleProvider from '../BimLocaleProvider';
import LocaleSwitch from '../../layout/LocaleSwitch';
import { writeSiteLocale } from '@/lib/site-locale';

function Probe() {
    const ctx = useContext(LocaleContext);
    return <span data-testid="probe">{ctx?.locale}</span>;
}

// 9-30 反馈（overview#322）：繁简在顶栏，组件库的页面要跟着它走
describe('BimLocaleProvider ↔ 顶栏繁简', () => {
    beforeEach(() => localStorage.removeItem('bim-locale'));

    it('顶栏切换后，Provider 外的顶栏与 Provider 里的组件库同步（顶栏不在 Provider 里也行）', () => {
        render(
            <>
                <LocaleSwitch />
                <BimLocaleProvider>
                    <Probe />
                </BimLocaleProvider>
            </>,
        );
        expect(screen.getByTestId('probe')).toHaveTextContent('zh-Hans');
        fireEvent.click(screen.getByRole('button', { name: /^繁\/简/ }));
        expect(screen.getByTestId('probe')).toHaveTextContent('zh-Hant');
        expect(localStorage.getItem('bim-locale')).toBe('zh-Hant');
    });

    it('组件库内部切换也同步回顶栏', () => {
        function InnerToggle() {
            const ctx = useContext(LocaleContext);
            return <button onClick={() => ctx?.setLocale('zh-Hant')}>inner</button>;
        }
        render(
            <>
                <LocaleSwitch />
                <BimLocaleProvider>
                    <InnerToggle />
                </BimLocaleProvider>
            </>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'inner' }));
        // 切到繁体后顶栏自己的文字也跟着变（overview#337），按钮名是繁体
        expect(screen.getByRole('button', { name: /當前繁體/ })).toBeInTheDocument();
    });

    it('挂载后读出已存的偏好', () => {
        localStorage.setItem('bim-locale', 'zh-Hant');
        render(<BimLocaleProvider><Probe /></BimLocaleProvider>);
        expect(screen.getByTestId('probe')).toHaveTextContent('zh-Hant');
        act(() => writeSiteLocale('zh-Hans'));
        expect(screen.getByTestId('probe')).toHaveTextContent('zh-Hans');
    });
});
