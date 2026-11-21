"""ops/iiif/renumber_manifest.py 单测：半叶编号 manifest → 页序编号。不联网。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))
import renumber_manifest as m  # noqa: E402

BASE = 'https://data.test/iiif/b/01'


def canvas(seg, w, h):
    cid = f'https://data.test/iiif/b/canvas/01/{seg}'
    return {'id': cid, 'type': 'Canvas', 'label': {'zh': [f'第 6 頁{seg[4:]}']}, 'width': w, 'height': h,
            'items': [{'id': f'{cid}/page', 'type': 'AnnotationPage', 'items': [{
                'id': f'{cid}/page/image', 'type': 'Annotation', 'target': cid,
                'body': {'type': 'Choice', 'items': [{'id': f'{BASE}/{seg}/full/1200,/0/default.webp'}]}}]}]}


def cord_pages(*specs):
    return [{'page': i, 'canvas': {'seq': f'{i:04d}', 'width': w, 'height': h}} for i, (w, h) in enumerate(specs, 1)]


class Renumber(unittest.TestCase):
    def test_half_leaf_to_page_seq(self):
        man = {'items': [canvas('0006a', 2568, 2672), canvas('0006c', 1764, 2616)]}
        new, st = m.renumber(man, cord_pages((2568, 2672), (1764, 2616)))
        self.assertEqual(st, 'ok')
        self.assertEqual([c['id'].rsplit('/', 1)[1] for c in new['items']], ['0001', '0002'])
        c0 = new['items'][0]
        self.assertEqual(c0['items'][0]['id'], 'https://data.test/iiif/b/canvas/01/0001/page')
        self.assertEqual(c0['items'][0]['items'][0]['target'], 'https://data.test/iiif/b/canvas/01/0001')
        # 图片地址不动
        self.assertEqual(c0['items'][0]['items'][0]['body']['items'][0]['id'], f'{BASE}/0006a/full/1200,/0/default.webp')
        self.assertEqual(c0['bim:leaf'], {'leaf': 6, 'part': 'a'})
        self.assertEqual(c0['label'], {'zh': ['第 1 頁']})
        self.assertEqual(man['items'][0]['id'].rsplit('/', 1)[1], '0006a')   # 不改入参

    def test_idempotent_skip(self):
        man = {'items': [canvas('0001', 10, 10), canvas('0002', 10, 10)]}
        new, st = m.renumber(man, cord_pages((10, 10), (10, 10)))
        self.assertEqual(st, 'skip')
        self.assertIs(new, man)

    def test_mismatch_raises(self):
        man = {'items': [canvas('0006a', 100, 100), canvas('0006c', 100, 100)]}
        with self.assertRaises(ValueError):
            m.renumber(man, cord_pages((100, 100)))                  # 页数不同
        with self.assertRaises(ValueError):
            m.renumber(man, cord_pages((100, 100), (100, 200)))      # 宽高对不上


if __name__ == '__main__':
    unittest.main()
