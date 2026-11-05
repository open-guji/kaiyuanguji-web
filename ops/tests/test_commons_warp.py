"""ops/iiif/commons_warp.py 单测：不联网。样例取自页表 96mid1ogzk/05/r004（A20 11-05 给的 0001/0002 页）。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))
import commons_warp as cw  # noqa: E402

PTS = {"t_R": [3968.9, 3246.7], "t_xr": [2266.9, 3236.0], "t_xl": [2095.8, 3234.9], "t_L": [364.3, 3224.0],
       "b_R": [3997.9, 5755.0], "b_xr": [2279.5, 5739.6], "b_xl": [2091.7, 5737.9], "b_L": [374.8, 5722.5]}
PAD = {"t": 36, "b": 36, "o": 36}
SRC = {"key": "wyg1", "kind": "commons", "name": "文淵閣四庫全書 0001冊.djvu", "commons_title": "File:文淵閣四庫全書 0001冊.djvu",
       "commons_url": "https://upload.wikimedia.org/wikipedia/commons/8/80/%E6%96%87%E6%B7%B5%E9%96%A3%E5%9B%9B%E5%BA%AB%E5%85%A8%E6%9B%B8_0001%E5%86%8A.djvu"}
RIGHT = {"seq": "0001", "w": 1824, "h": 2575, "src": "wyg1", "djvu_page": 234, "half": "右", "frame": {"pts": PTS, "pad": PAD}}
LEFT = {"seq": "0002", "w": 1853, "h": 2571, "src": "wyg1", "djvu_page": 234, "half": "左", "frame": {"pts": PTS, "pad": PAD}}


def apply(m, x, y):
    z = m[6] * x + m[7] * y + m[8]
    return (m[0] * x + m[1] * y + m[2]) / z, (m[3] * x + m[4] * y + m[5]) / z


class CommonsWarp(unittest.TestCase):
    def test_homography_roundtrip(self):
        h = cw.solve_homography([(0, 0), (10, 1), (11, 12), (-1, 9)], [(0, 0), (5, 0), (5, 8), (0, 8)])
        flat = [v for r in h for v in r]
        self.assertAlmostEqual(apply(flat, 10, 1)[0], 5, 6)
        self.assertAlmostEqual(apply(flat, -1, 9)[1], 8, 6)

    def test_right_half_corners(self):
        m, (W, H) = cw.page_matrix(RIGHT, 4296, 6064)
        self.assertEqual((W, H), (1824, 2575))
        flat = [v for r in m for v in r]
        k = 3840 / 4296
        x, y = apply(flat, PTS['t_R'][0] * k, PTS['t_R'][1] * k)
        self.assertAlmostEqual(x, 1788, delta=0.5)      # 右半叶 l=0，外侧补 o 在右
        self.assertAlmostEqual(y, 36, delta=0.5)
        x, y = apply(flat, PTS['b_R'][0] * k, PTS['b_R'][1] * k)
        self.assertAlmostEqual(y, 2539, delta=0.5)

    def test_left_half_corner(self):
        m, (W, H) = cw.page_matrix(LEFT, 4296, 6064)
        self.assertEqual((W, H), (1853, 2571))
        x, y = apply([v for r in m for v in r], PTS['t_L'][0] * 3840 / 4296, PTS['t_L'][1] * 3840 / 4296)
        self.assertAlmostEqual(x, 36, delta=0.5)
        self.assertAlmostEqual(y, 36, delta=0.5)

    def test_thumb_url_and_field(self):
        u = cw.thumb_url(SRC, 234)
        self.assertTrue(u.startswith('https://upload.wikimedia.org/wikipedia/commons/thumb/8/80/'))
        self.assertTrue(u.endswith('/page234-3840px-%E6%96%87%E6%B7%B5%E9%96%A3%E5%9B%9B%E5%BA%AB%E5%85%A8%E6%9B%B8_0001%E5%86%8A.djvu.jpg'))
        c = cw.canvas_commons({'sources': [SRC]}, RIGHT)
        self.assertEqual(len(c['matrix']), 9)
        self.assertEqual((c['width'], c['height']), (3840, 5420))

    def test_skips_when_not_applicable(self):
        self.assertIsNone(cw.canvas_commons({'sources': [SRC]}, {**RIGHT, 'frame': None}))
        self.assertIsNone(cw.canvas_commons({'sources': [{**SRC, 'kind': 'ia'}]}, RIGHT))
        self.assertIsNone(cw.canvas_commons({'sources': [SRC]}, {**RIGHT, 'w': 1700}))     # 宽高对不上：不是这套版框


if __name__ == '__main__':
    unittest.main()
