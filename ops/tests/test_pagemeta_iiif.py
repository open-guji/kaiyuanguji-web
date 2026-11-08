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
