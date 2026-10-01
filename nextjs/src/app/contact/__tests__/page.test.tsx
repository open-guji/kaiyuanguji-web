jest.mock('next/navigation', () => ({
    permanentRedirect: jest.fn(() => {
        throw new Error('NEXT_REDIRECT');
    }),
}));

import { permanentRedirect } from 'next/navigation';
import ContactPage from '../page';

// 9-30 反馈（overview#322）：联系页并进关于页，旧地址 308 到 /about#联系（Location 头只能 ASCII，锚点百分号编码）
describe('/contact', () => {
    it('永久跳转到关于页的「联系我们」一节', () => {
        expect(() => ContactPage()).toThrow('NEXT_REDIRECT');
        expect(permanentRedirect).toHaveBeenCalledWith('/about#%E8%81%94%E7%B3%BB');
        expect(decodeURIComponent('/about#%E8%81%94%E7%B3%BB')).toBe('/about#联系');
    });
});
