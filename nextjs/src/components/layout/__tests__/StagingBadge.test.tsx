import { render, screen } from '@testing-library/react';

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
});
