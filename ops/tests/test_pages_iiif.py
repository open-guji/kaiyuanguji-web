"""ops/iiif/pages_iiif.py 单测：别的书（非四庫總目）从 cv 页表出书影。不联网、不碰 COS。"""
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))

try:
    from PIL import Image
    import pages_iiif as m
    import siku_zongmu_iiif as s
except ImportError:  # 没装 Pillow 时整组跳过
    m = None


@unittest.skipIf(m is None, 'Pillow 未安装')
class PagesIiif(unittest.TestCase):
    def setUp(self):
        self._book = s.BOOK_ID

    def tearDown(self):
        s.BOOK_ID = self._book

    def test_books_registry(self):
        books = m.load_books()
        self.assertNotIn('96mid1ogzk', books)        # 四庫總目走 siku_zongmu_iiif.py
        for bid, meta in books.items():
            self.assertRegex(bid, r'^[0-9a-z]{10}$')
            self.assertTrue(meta['title'] and meta['source'] and meta['vols'])
            self.assertTrue(all(len(v) == 2 and v.isdigit() for v in meta['vols']))

    def test_slice_and_manifest_from_table(self):
        s.BOOK_ID = '988g7gsqhd'
        meta = m.load_books()['988g7gsqhd']
        im = Image.new('L', (1600, 1300), 200)
        b = io.BytesIO()
        im.save(b, 'PNG')
        data = b.getvalue()
        sha = __import__('hashlib').sha256(data).hexdigest()
        table = {'rev': 1, 'book_id': '988g7gsqhd',
                 'pages': [{'seq': '0001', 'page': 1, 'sha256': sha, 'ops': []},
                           {'seq': '0002', 'page': 2, 'sha256': sha, 'ops': []}]}
        with tempfile.TemporaryDirectory() as d:
            cache, out = os.path.join(d, 'cache'), os.path.join(d, 'out')
            p = s.page_path(cache, sha)
            os.makedirs(os.path.dirname(p))
            with open(p, 'wb') as f:
                f.write(data)
            r = s.slice_volume(1, {'ia': None}, {}, out, cache, jobs=1, table=table)
            self.assertTrue(os.path.exists(os.path.join(out, 'iiif/988g7gsqhd/01/0002/full/1200,/0/default.webp')))
            man = m.build_manifest(meta, 1, r['canvases'], table)
        self.assertTrue(man['id'].endswith('/iiif/988g7gsqhd/01/manifest.json'))
        self.assertEqual(len(man['items']), 2)
        body = man['items'][1]['items'][0]['items'][0]['body']['items']
        self.assertEqual(len(body), 1)                # 只有本站图源
        self.assertRegex(body[0]['id'], r'/iiif/988g7gsqhd/01/0002/full/1200,/0/default\.webp$')
        self.assertTrue(man['items'][0]['id'].endswith('/iiif/988g7gsqhd/canvas/01/0001'))
        coll = m.build_collection(meta, {1})
        self.assertEqual(coll['items'][0]['id'], man['id'])


if __name__ == '__main__':
    unittest.main()
