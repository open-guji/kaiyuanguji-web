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
            self.assertTrue(all(len(v) in (2, 3) and v.isdigit() for v in meta['vols']))
            self.assertEqual(len({len(v) for v in meta['vols']}), 1)   # 一部书的册号位数一致

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
            r = s.slice_volume('01', {'ia': None}, {}, out, cache, jobs=1, table=table)
            self.assertTrue(os.path.exists(os.path.join(out, 'iiif/988g7gsqhd/01/0002/full/1200,/0/default.webp')))
            man = m.build_manifest(meta, '01', r['canvases'], table)
            self.assertEqual(s.sample_sheet(out, {'volumes': {'01': r}}, n=1)[0][:5], 'vol01')
        self.assertTrue(man['id'].endswith('/iiif/988g7gsqhd/01/manifest.json'))
        self.assertEqual(len(man['items']), 2)
        body = man['items'][1]['items'][0]['items'][0]['body']['items']
        self.assertEqual(len(body), 1)                # 只有本站图源
        self.assertRegex(body[0]['id'], r'/iiif/988g7gsqhd/01/0002/full/1200,/0/default\.webp$')
        self.assertTrue(man['items'][0]['id'].endswith('/iiif/988g7gsqhd/canvas/01/0001'))
        coll = m.build_collection(meta, {'01'})
        self.assertEqual(coll['items'][0]['id'], man['id'])

    def test_three_digit_vol_and_seq_by_page(self):
        # 全唐文：册号 3 位、页表 seq 从 0002 起且有跳号 → 书影目录用 '005'，canvas 页序按 page 编，与 cord 对上
        s.BOOK_ID = '995ejelvk0'
        meta = m.load_books()['995ejelvk0']
        self.assertIn('005', meta['vols'])
        self.assertEqual(m.vol_label(meta, '005'), f'{meta["title"]} 第 5 冊 卷七～卷十')
        table = {'rev': 1, 'book_id': '995ejelvk0',
                 'pages': [{'seq': '0002', 'page': 1, 'sha256': 'a', 'ops': []},
                           {'seq': '0107', 'page': 2, 'sha256': 'b', 'ops': []},
                           {'seq': '0110', 'page': 3, 'sha256': 'c', 'ops': []}]}
        plan = s.plan_from_pages(m.seq_by_page(table))
        self.assertEqual([c['seq'] for c in plan], ['0001', '0002', '0003'])
        self.assertEqual([c['sha256'] for c in plan], ['a', 'b', 'c'])
        self.assertTrue(s.canvas_id('005', '0001').endswith('/iiif/995ejelvk0/canvas/005/0001'))
        self.assertEqual(s.manifest_key('005'), 'iiif/995ejelvk0/005/manifest.json')
        # 拆页后缀的页表不动
        split = {'pages': [{'seq': '0003a', 'page': 3}, {'seq': '0003b', 'page': 4}]}
        self.assertIs(m.seq_by_page(split), split)


if __name__ == '__main__':
    unittest.main()
