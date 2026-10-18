"""测试用候选来源：整章作为一段，候选＝章内含查询串的段（用原型 locate 判定）。不依赖 Tantivy。"""
from common import locate


class FakeSource:
    def __init__(self, books):
        # books: {entry: {'title': str, 'chapters': [(chapter, label, text), ...]}}
        self.books = books
        self.segs = [
            {'entry': e, 'chapter': c, 'label': lab, 'start': 0, 'end': len(txt)}
            for e, b in books.items() for c, lab, txt in b['chapters']
        ]
        self.text = {(e, c): txt for e, b in books.items() for c, _, txt in b['chapters']}

    def book_title(self, entry):
        return self.books[entry]['title']

    def chapter_text(self, entry, chapter):
        return self.text[(entry, chapter)]

    def candidates(self, needle, field, entry, k):
        out = []
        for s in self.segs:
            if entry and s['entry'] != entry:
                continue
            if locate(self.text[(s['entry'], s['chapter'])], needle, field):
                out.append(s)
                if k is not None and len(out) >= k:
                    break
        return out


SAMPLE = {
    'B1': {'title': '論語集解', 'chapters': [
        ('001', '學而第一', '子曰：學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？'),
        ('002', '為政第二', '子曰：為政以德，譬如北辰。學而不思則罔。'),
    ]},
    'B2': {'title': '孟子', 'chapters': [
        ('001', '梁惠王上', '孟子見梁惠王。王曰：叟，不遠千里而來，亦將有以利吾國乎？'),
    ]},
}
