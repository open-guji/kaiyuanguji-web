import { render, screen } from '@testing-library/react';

// 角标文字走字典 <T>（overview#337，内部用 hook）。resetModules 后重新 import 会拿到另一份 React，
// 与 testing-library 那份对不上（Invalid hook call）；把 react 钉成同一份。
const REACT = jest.requireActual('react');
beforeEach(() => {
    jest.doMock('react', () => REACT);
});

// SITE_ENV 在 constants.ts 里是模块加载时读的 process.env，
// 每个用例要不同取值，必须 resetModules 后动态 import 才能生效。
describe('StagingBadge（T1 测试站角标）', () => {
    const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SITE_ENV;

    afterEach(() => {
        process.env.NEXT_PUBLIC_SITE_ENV = ORIGINAL_ENV;
        jest.resetModules();
    });

    it('NEXT_PUBLIC_SITE_ENV=staging 时渲染角标', async () => {
        jest.resetModules();
        process.env.NEXT_PUBLIC_SITE_ENV = 'staging';
        const { default: StagingBadge } = await import('../StagingBadge');
        render(<StagingBadge />);
        expect(screen.getByTestId('staging-badge')).toHaveTextContent('测试站');
    });

    it('未设置（正式站）时不渲染任何内容', async () => {
        jest.resetModules();
        delete process.env.NEXT_PUBLIC_SITE_ENV;
        const { default: StagingBadge } = await import('../StagingBadge');
        const { container } = render(<StagingBadge />);
        expect(container).toBeEmptyDOMElement();
    });

    it('值不是 staging（如 production）时不渲染', async () => {
        jest.resetModules();
        process.env.NEXT_PUBLIC_SITE_ENV = 'production';
        const { default: StagingBadge } = await import('../StagingBadge');
        const { container } = render(<StagingBadge />);
        expect(container).toBeEmptyDOMElement();
    });

    it('字色是深琥珀、不是白：白字压 #fe9a00 只有 2.13:1（axe color-contrast 要 4.5）', async () => {
        jest.resetModules();
        process.env.NEXT_PUBLIC_SITE_ENV = 'staging';
        const { default: StagingBadge } = await import('../StagingBadge');
        render(<StagingBadge />);
        const cls = screen.getByTestId('staging-badge').className;
        expect(cls).toContain('bg-amber-500');
        expect(cls).toContain('text-amber-950');
        expect(cls).not.toMatch(/text-white/);
    });
});
