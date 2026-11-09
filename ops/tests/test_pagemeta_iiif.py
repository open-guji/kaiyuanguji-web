"""ops/iiif/pagemeta.py 单测：不联网。"""
import json
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))
import pagemeta as pm  # noqa: E402

TABLE = {'book_id': 'b', 'vol': '05', 'rev': 4, 'pages': [{'seq': '0001', 'sha256': 'aa'}, {'seq': '0002', 'sha256': 'bb'}]}
I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
PERSP = [[0.5, 0.01, 10], [-0.01, 0.5, 20], [1e-6, 2e-6, 1]]


def sidecar(**kw):
    d = {'schema': 'guji-pagemeta/1', 'book_id': 'b', 'vol': '05', 'rev': 4, 'v': 2, 'table_sha256': pm.table_sha(TABLE), 'pages': {}}
    d.update(kw)
    return d


def fake_get(files):
    def get(url, timeout=0, tries=0):
        if url in files:
            return json.dumps(files[url]).encode(), {}
        raise urllib.error.HTTPError(url, 404, 'nf', {}, None)
    return get


URL = lambda v: f'https://pb/pack/source/pages/b/05/r004.page.v{v}.json'  # noqa: E731


class PageMeta(unittest.TestCase):
    def test_sha_matches_cv_definition(self):
        import hashlib
        self.assertEqual(pm.table_sha(TABLE), hashlib.sha256(b'0001:aa\n0002:bb\n').hexdigest())

    def test_latest_version_and_none(self):
        g = fake_get({URL(1): sidecar(v=1), URL(2): sidecar(v=2)})
        self.assertEqual(pm.load_pagemeta(TABLE, 'https://pb', '05', g)['v'], 2)
        self.assertIsNone(pm.load_pagemeta(TABLE, 'https://pb', '05', fake_get({})))

    def test_mismatch_raises(self):
        for bad in (sidecar(table_sha256='x'), sidecar(rev=3), sidecar(book_id='z'), sidecar(schema='other')):
            with self.assertRaises(RuntimeError):
                pm.load_pagemeta(TABLE, 'https://pb', '05', fake_get({URL(1): bad}))

    def test_bim_page_flat_and_src_tier(self):
        pub = lambda k: 'https://d/' + k  # noqa: E731
        e = {'src': {'id': 'WYG-SKQS-0001.djvu#235', 'w': 4296, 'h': 6064}, 'H': PERSP, 'content': [3, 4.2, 700, 900]}
        out = pm.bim_page(e, pub, 'b', '05')
        self.assertEqual(out['H'], [0.5, 0.01, 10, -0.01, 0.5, 20, 1e-6, 2e-6, 1])
        self.assertEqual(out['content'], [3, 4, 700, 900])
        self.assertNotIn('url', out['src'])                      # 源图档没上传：不写 url
        out = pm.bim_page(e, pub, 'b', '05', with_src_tier=True)
        self.assertEqual(out['src']['url'], 'https://d/iiif/b/05/src/WYG-SKQS-0001-235/full/2400,/0/default.webp')

    def test_identity_never_gets_src_url(self):
        e = {'src': {'id': 'sha256:abc', 'w': 100, 'h': 200}, 'H': I3, 'content': [0, 0, 100, 200]}
        self.assertNotIn('url', pm.bim_page(e, lambda k: k, 'b', '05', with_src_tier=True)['src'])

    def test_slug(self):
        self.assertEqual(pm.src_slug('WYG-SKQS-0001.djvu#235'), 'WYG-SKQS-0001-235')
        self.assertEqual(pm.src_slug('CADAL06061302 x.djvu#5'), 'CADAL06061302-x-5')


if __name__ == '__main__':
    unittest.main()


class TestWygSrcTier(unittest.TestCase):
    def test_needed_pages_skips_identity_and_shares_slug(self):
        import wyg_src_tier
        H = [[1.01, 0, 5], [0, 1.02, 6], [0, 0, 1]]
        ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        meta = {'pages': {
            '0001': {'src': {'id': 'WYG-SKQS-0001.djvu#51', 'w': 4296, 'h': 6064}, 'H': H},
            '0002': {'src': {'id': 'WYG-SKQS-0001.djvu#51', 'w': 4296, 'h': 6064}, 'H': H},
            '0003': {'src': {'id': 'X.djvu#9', 'w': 10, 'h': 10}, 'H': ident},
        }}
        self.assertEqual(wyg_src_tier.needed_pages(meta), {'WYG-SKQS-0001-51': (51, 4296, 6064)})


class TestBanxinViews(unittest.TestCase):
    TP = {'half': '右', 'frame': {'pts': {
        't_R': [3800, 3200], 't_xr': [2130, 3190], 't_xl': [1950, 3190], 't_L': [250, 3180],
        'b_R': [3790, 5700], 'b_xr': [2130, 5690], 'b_xl': [1945, 5690], 'b_L': [250, 5670]},
        'pad': {'t': 36, 'b': 36, 'o': 36}}}
    ENT = {'src': {'id': 'A.djvu#1', 'w': 4296, 'h': 6064}, 'H': [[1, 0, 2000], [0, 1, 3000], [0, 0, 1]],
           'content': [0, 8, 1800, 2548]}

    def test_right_half_none_and_full(self):
        v = pm.banxin_views(self.TP, self.ENT)
        # none：页图 x = S x − 2000；右半叶 [版心右边线 2130−8, 右外线 3800+36] → 122..1836
        self.assertEqual(v['none'][0], 122)
        self.assertEqual(v['none'][0] + v['none'][2], 1836)
        # full：S 坐标，[版心左边线 1945−8, 3836]
        self.assertEqual(v['full'][0], 1937)
        self.assertEqual(v['full'][0] + v['full'][2], 3836)

    def test_left_half_mirrors(self):
        tp = {**self.TP, 'half': '左'}
        v = pm.banxin_views(tp, self.ENT)
        self.assertEqual(v['full'][0], 250 - 36)
        self.assertEqual(v['full'][0] + v['full'][2], 2130 + 8)

    def test_missing_frame_gives_none(self):
        self.assertIsNone(pm.banxin_views({'half': '右'}, self.ENT))
        self.assertIsNone(pm.banxin_views(None, self.ENT))

    def test_bim_page_views_full_needs_src_url(self):
        pub = lambda k: 'https://x/' + k  # noqa: E731
        a = pm.bim_page(self.ENT, pub, 'b', '01', with_src_tier=False, tpage=self.TP)
        self.assertIn('none', a['views'])
        self.assertNotIn('full', a['views'])
        b = pm.bim_page(self.ENT, pub, 'b', '01', with_src_tier=True, tpage=self.TP)
        self.assertIn('full', b['views'])
