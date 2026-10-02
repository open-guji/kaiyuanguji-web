/**
 * 条目页写「最近浏览」（overview#359 P2-1）：/item/<id> 打开即记，元数据首页的最近浏览栏读同一个键。
 */
import { render } from '@testing-library/react';
import { RECENT_IDS_STORAGE_KEY } from 'book-index-ui';

jest.mock('@/components/common/BimLocaleProvider', () => ({ children }: { children: React.ReactNode }) => <>{children}</>);
jest.mock('@/components/book-index/BookDetailContent', () => () => <div data-testid="detail" />);

import ItemDetailClient from '../ItemDetailClient';

const ids = () => JSON.parse(window.localStorage.getItem(RECENT_IDS_STORAGE_KEY) ?? '[]');

describe('ItemDetailClient：最近浏览', () => {
    beforeEach(() => window.localStorage.clear());

    it('打开条目就记下 id，新的在前、不重复', () => {
        const { rerender } = render(<ItemDetailClient id="d59f20aowb9c" fallback={null} />);
        expect(ids()).toEqual(['d59f20aowb9c']);
        rerender(<ItemDetailClient id="d59df01avcw0" fallback={null} />);
        expect(ids()).toEqual(['d59df01avcw0', 'd59f20aowb9c']);
        rerender(<ItemDetailClient id="d59f20aowb9c" fallback={null} />);
        expect(ids()).toEqual(['d59f20aowb9c', 'd59df01avcw0']);
    });

    it('localStorage 写不进去（隐私模式等）也不影响页面', () => {
        const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
        expect(() => render(<ItemDetailClient id="d59f20aowb9c" fallback={null} />)).not.toThrow();
        spy.mockRestore();
    });
});
