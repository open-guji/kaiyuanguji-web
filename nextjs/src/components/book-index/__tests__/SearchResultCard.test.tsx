import { fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider, SNIPPET_MARK_END, SNIPPET_MARK_START, type IndexEntry } from 'book-index-ui';
import SearchResultCard from '../SearchResultCard';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const shiji: IndexEntry = {
    id: '988g3f0wsu',
    type: 'book',
    title: '史記',
    dynasty: '西漢',
    author: '司馬遷',
    era: '清',
    edition: '欽定四庫全書文淵閣本',
    measure_info: '一百三十卷',
    has_image: true,
    has_text: true,
};

function renderCard(entry: IndexEntry, query?: string) {
    return render(<LocaleProvider><SearchResultCard entry={entry} query={query} /></LocaleProvider>);
}

beforeEach(() => {
    push.mockClear();
    localStorage.clear();
});

describe('SearchResultCard', () => {
    it('整张卡是指向条目的真链接', () => {
        renderCard(shiji);
        const link = screen.getByRole('link');
        expect(link).toHaveAttribute('href', '/item/988g3f0wsu');
        expect(link).toHaveTextContent(/史[記记]/);
    });

    it('元数据写成辅助字，只有「有影印」是标记', () => {
        renderCard(shiji);
        expect(screen.getByText(/有影印/)).toBeInTheDocument();
        expect(screen.getByText(/一百三十卷/)).toBeInTheDocument();
        expect(screen.getByText(/〔[清]〕/)).toBeInTheDocument();
        renderCard({ ...shiji, id: 'x', has_image: false });
        expect(screen.getAllByText(/有影印/)).toHaveLength(1);
    });

    it('普通左键走客户端路由并记入最近浏览；修饰键交给浏览器', () => {
        renderCard(shiji);
        const link = screen.getByRole('link');
        fireEvent.click(link, { button: 0 });
        expect(push).toHaveBeenCalledWith('/item/988g3f0wsu');
        expect(JSON.parse(localStorage.getItem('bim-recent-ids') || '[]')).toEqual(['988g3f0wsu']);

        push.mockClear();
        fireEvent.click(link, { button: 0, metaKey: true });
        expect(push).not.toHaveBeenCalled();
    });

    it('简介命中片段用 <mark> 高亮，不当 HTML 注入', () => {
        const { container } = renderCard({
            ...shiji,
            descriptionSnippet: `全書${SNIPPET_MARK_START}凡一百三十篇${SNIPPET_MARK_END}<b>x</b>`,
        });
        expect(container.querySelector('mark')).toHaveTextContent(/一百三十篇/);
        expect(container.querySelector('b')).toBeNull();
    });

    it('别名命中时写出别名', () => {
        renderCard({ ...shiji, additional_titles: ['太史公書'] }, '太史公');
        expect(screen.getByText(/太史公[書书]/)).toBeInTheDocument();
    });
});
