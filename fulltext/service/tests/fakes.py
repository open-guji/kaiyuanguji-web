"""测试用来源：把一小份样书用 build_pack 同一套切段与字段写进内存 Tantivy 索引，
再用正式的 TantivySource 去查。测的是真实查询路径，不是另写一套假实现。"""
import tantivy

import build_pack
from source_tantivy import TantivySource


class FakeSource(TantivySource):
    def __init__(self, books):
        # books: {entry: {'title': str, 'chapters': [(chapter, label, text), ...]}}
        # label 非空时作为章首标题行（# label）写进正文，和 book-text 的 md 一样
        self.books = books
        self.text = {}
        index = tantivy.Index(build_pack.build_schema())
        w = index.writer(15_000_000, 1)
        for e, b in books.items():
            ord0 = 0
            for c, lab, txt in b['chapters']:
                md = (f'# {lab}\n' if lab else '') + txt
                self.text[(e, c)] = md
                docs = build_pack.chapter_docs(e, c, md, ord0)
                ord0 += len(docs)
                for d in docs:
                    d.pop('nchar')
                    w.add_document(tantivy.Document(**d))
        w.commit()
        w.wait_merging_threads()
        index.reload()
        self.index, self.searcher = index, index.searcher()
        self.index_dir = ''
        self.titles = {e: b['title'] for e, b in books.items()}

    def _open(self):
        pass

    def reload(self):
        return None


SAMPLE = {
    'B1': {'title': '論語集解', 'chapters': [
        ('001', '學而第一', '子曰：學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？人不知而不慍，不亦君子乎？\n'),
        ('002', '為政第二', '子曰：為政以德，譬如北辰，居其所而眾星共之。學而不思則罔，思而不學則殆。\n'),
    ]},
    'B2': {'title': '孟子', 'chapters': [
        ('001', '梁惠王上', '孟子見梁惠王。王曰：叟，不遠千里而來，亦將有以利吾國乎？孟子對曰：王何必曰利。\n'),
    ]},
}
