"""ops/iiif/original_books.py 单测：从 book-text 的 manifest 推自做书名单、PROOF_WS、pages-books 条目。不联网。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))
import original_books as ob  # noqa: E402


def put(root, bid, versions, chapters=None):
    d = os.path.join(root, 'Book', bid[0], bid[1], bid[2], bid)
    os.makedirs(os.path.join(d, 'default'))
    with open(os.path.join(d, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'id': bid, 'versions': versions}, f, ensure_ascii=False)
    if chapters is not None:
        with open(os.path.join(d, 'default', 'index.json'), 'w', encoding='utf-8') as f:
            json.dump({'chapters': chapters}, f, ensure_ascii=False)


ORIG = {'key': 'default', 'is_original': True, 'source_name': '開源古籍CV整理（某某刻本，某館藏）'}
WIKI = {'key': 'default', 'source_name': '維基文庫'}


class OriginalBooks(unittest.TestCase):
    def tree(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        put(d.name, 'aaaaaaaaaa', [ORIG], [{'n': 1, 'file': '001', 'title': '卷一'}, {'n': 2, 'file': '002', 'title': '卷二'}])
        put(d.name, 'bbbbbbbbbb', [WIKI], [{'n': 1, 'file': '001', 'title': 'x'}])             # 不是自做书
        put(d.name, 'cccccccccc', [WIKI, {**ORIG, 'key': 'cv-proof'}])                           # 非主版本自做：算；还没有章
        put(d.name, '988g7gsqhd', [ORIG], [{'n': 1, 'file': '001', 'title': '北行日錄'}])         # 旧工作区名
        return d.name

    def test_scan_and_proof_ws(self):
        books = ob.scan(self.tree())
        self.assertEqual(list(books), ['988g7gsqhd', 'aaaaaaaaaa', 'cccccccccc'])
        self.assertEqual(ob.proof_ws(books), ['beixing-guben', 'aaaaaaaaaa', 'cccccccccc'])

    def test_derive_pages_books(self):
        pb = ob.derive_pages_books(ob.scan(self.tree()))
        self.assertNotIn('cccccccccc', pb)                    # 没有章，册目录推不出
        a = pb['aaaaaaaaaa']
        self.assertEqual((a['title'], a['source']), ('某某刻本，某館藏', '某某刻本，某館藏'))
        self.assertEqual(a['vols'], {'01': {'juan': '卷一'}, '02': {'juan': '卷二'}})
        wide = ob.derive_pages_books(ob.scan(self.tree()), {'aaaaaaaaaa': 3})
        self.assertEqual(list(wide['aaaaaaaaaa']['vols']), ['001', '002'])

    def test_edition_of(self):
        self.assertEqual(ob.edition_of('開源古籍CV整理（嘉慶內府本，清華 CADAL）'), '嘉慶內府本，清華 CADAL')
        self.assertEqual(ob.edition_of('別的格式'), '別的格式')


if __name__ == '__main__':
    unittest.main()
