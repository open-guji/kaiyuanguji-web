"""ops/iiif/siku_zongmu_iiif.py 单测（overview#388）：不联网、不碰 COS。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'iiif'))

try:
    from PIL import Image, ImageChops, ImageDraw
    import siku_zongmu_iiif as m
except ImportError:  # 没装 Pillow 时整组跳过
    m = None


@unittest.skipIf(m is None, 'Pillow 未安装')
class SikuIiif(unittest.TestCase):
    def test_volumes(self):
        vols = m.load_volumes()
        self.assertEqual(len(vols), 99)
        self.assertEqual(sum(v['leaves'] for v in vols.values()), 16628)
        self.assertEqual(vols[2]['ia'], '06061301.cn')
        self.assertEqual(vols[3]['ia'], '06061302.cn')
        self.assertEqual(vols[8]['leaves'], 69)

    def test_plan_split_volume(self):
        plan = m.plan_canvases(3, 107, m.load_splits())
        seqs = [c['seq'] for c in plan]
        self.assertEqual(len(plan), 110)  # 合扫叶 105 换成 a–d 四块
        self.assertEqual(seqs[103:110], ['0104', '0105a', '0105b', '0105c', '0105d', '0106', '0107'])
        self.assertEqual(plan[104]['xywh'], [2096, 0, 2102, 2913])

    def test_plan_plain_volume(self):
        plan = m.plan_canvases(2, 188, m.load_splits())
        self.assertEqual([c['seq'] for c in plan[:2]], ['0001', '0002'])
        self.assertTrue(all(c['xywh'] is None for c in plan))

    def test_cos_signature_matches_sdk(self):
        # 期望值来自 cos-nodejs-sdk-v5 COS.getAuthorization（同样参数、KeyTime 1700000000;1700001000）
        auth = m.cos_authorization('AKIDtest', 'skey123', 'PUT',
                                   '/iiif/96mid1ogzk/02/0010/full/1200,/0/default.webp',
                                   {'Host': 'b-1250000000.cos.ap-shanghai.myqcloud.com'}, now=1700000060, ttl=940)
        self.assertTrue(auth.endswith('q-header-list=host&q-url-param-list=&q-signature=aacd54b4905e25d5e2fa80a817c681bfcb3e10f3'))

    def _bw_page(self):
        im = Image.new('1', (2360, 3080), 1)
        d = ImageDraw.Draw(im)
        for x in range(100, 2200, 160):
            d.rectangle((x, 200, x + 60, 2800), fill=0)
        return im

    def test_bw_tiers(self):
        src = self._bw_page()
        tiers = m.encode_tiers(src)
        self.assertEqual([(n, w) for n, w, _, _ in tiers], [('thumb', 300), ('read', 1200), ('zoom', 2360)])
        import io
        zoom = Image.open(io.BytesIO(tiers[2][3])).convert('L')
        self.assertIsNone(ImageChops.difference(zoom, src.convert('L')).getbbox())  # 放大档与原图逐像素一致
        read = Image.open(io.BytesIO(tiers[1][3])).convert('L')
        self.assertLessEqual(set(read.getdata()), {0, 85, 170, 255})  # 4 级灰

    def test_manifest_shape(self):
        canv = [{'seq': '0105a', 'leaf': 105, 'xywh': [2096, 0, 2102, 2913], 'pos': '右上', 'width': 2102,
                 'height': 2913, 'mode': '1', 'tiers': [('thumb', 300, 416, 1), ('read', 1200, 1663, 1), ('zoom', 2102, 2913, 1)]},
                {'seq': '0106', 'leaf': 106, 'xywh': None, 'pos': None, 'width': 2361, 'height': 3155, 'mode': '1',
                 'tiers': [('thumb', 300, 401, 1), ('read', 1200, 1604, 1), ('zoom', 2361, 3155, 1)]}]
        meta = {'ia': '06061302.cn', 'leaves': 107, 'juan': '卷四~卷五'}
        commons = {'name': 'X.djvu', 'url': 'https://upload.wikimedia.org/wikipedia/commons/8/86/X.djvu', 'pagecount': 107}
        man = m.build_manifest(3, meta, canv, commons)
        self.assertEqual(man['id'], 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/03/manifest.json')
        split, plain = man['items']
        self.assertEqual(split['id'], 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/canvas/03/0105a')
        self.assertEqual(split['source']['selector']['value'], 'xywh=2096,0,2102,2913')
        body = split['items'][0]['items'][0]['body']['items']
        self.assertEqual([b['label']['zh'][0] for b in body], ['本站', 'Internet Archive'])  # 拆页不挂 Commons
        self.assertIn('/2096,0,2102,2913/1200,/0/default.jpg', body[1]['id'])
        body = plain['items'][0]['items'][0]['body']['items']
        self.assertEqual([b['label']['zh'][0] for b in body], ['本站', '维基共享资源', 'Internet Archive'])
        self.assertEqual(body[0]['id'], 'https://data.kaiyuanguji.com/iiif/96mid1ogzk/03/0106/full/1200,/0/default.webp')
        self.assertEqual(body[1]['id'],
                         'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/X.djvu/page106-1280px-X.djvu.jpg')

    def test_upload_order_images_then_manifests_then_collection(self):
        import tempfile
        from unittest import mock
        with tempfile.TemporaryDirectory() as root:
            for key in ['iiif/96mid1ogzk/manifest.json', 'iiif/96mid1ogzk/03/manifest.json',
                        'iiif/96mid1ogzk/03/0001/info.json', 'iiif/96mid1ogzk/03/0001/full/300,/0/default.webp']:
                os.makedirs(os.path.join(root, os.path.dirname(key)), exist_ok=True)
                with open(os.path.join(root, key), 'wb') as f:
                    f.write(b'x')
            order = []
            fake = mock.Mock()
            fake.put.side_effect = lambda key, *a, **k: order.append(key)
            with mock.patch.object(m, 'Cos', return_value=fake):
                m.upload_tree(root, workers=2)
        self.assertEqual(order[-2:], ['iiif/96mid1ogzk/03/manifest.json', 'iiif/96mid1ogzk/manifest.json'])

    def _tree(self, root, keys):
        for key in keys:
            os.makedirs(os.path.join(root, os.path.dirname(key)), exist_ok=True)
            with open(os.path.join(root, key), 'wb') as f:
                f.write(b'x')

    def test_upload_skips_images_already_in_bucket(self):
        # overview#410：桶里 ETag 与本地 MD5 一致的图和 info.json 不再重传；manifest、Collection 每次都传
        import hashlib
        import tempfile
        from unittest import mock
        keys = ['iiif/96mid1ogzk/manifest.json', 'iiif/96mid1ogzk/03/manifest.json',
                'iiif/96mid1ogzk/03/0001/info.json', 'iiif/96mid1ogzk/03/0001/full/300,/0/default.webp',
                'iiif/96mid1ogzk/03/0002/full/300,/0/default.webp']
        same = hashlib.md5(b'x').hexdigest()
        with tempfile.TemporaryDirectory() as root:
            self._tree(root, keys)
            fake = mock.Mock()
            fake.etag.side_effect = lambda key: {keys[3]: same, keys[2]: same, keys[4]: 'different'}.get(key)
            with mock.patch.object(m, 'Cos', return_value=fake):
                r = m.upload_tree(root, workers=2)
                put_keys = [c.args[0] for c in fake.put.call_args_list]
                self.assertEqual(sorted(put_keys), sorted([keys[0], keys[1], keys[4]]))
                self.assertEqual((r['uploaded'], r['skipped']), (3, 2))
                self.assertEqual(r['uploaded_keys'], sorted([keys[0], keys[1], keys[4]]))
                fake.reset_mock()
                r = m.upload_tree(root, workers=2, force=True)
                self.assertEqual(fake.put.call_count, 5)
                fake.etag.assert_not_called()
                self.assertEqual(r['skipped'], 0)

    def test_pick_verify_files(self):
        files = [(f'/t/{i}', f'iiif/96mid1ogzk/03/{i:04d}/full/300,/0/default.webp') for i in range(500)]
        files += [('/t/m', 'iiif/96mid1ogzk/03/manifest.json'), ('/t/c', 'iiif/96mid1ogzk/manifest.json')]
        self.assertEqual(len(m.pick_verify_files(files, None)), 502)  # 没做上传或 --force：全核
        up = [files[3][1], files[7][1]]
        got = m.pick_verify_files(files, up)
        keys = {k for _, k in got}
        self.assertTrue({files[3][1], files[7][1], 'iiif/96mid1ogzk/03/manifest.json',
                         'iiif/96mid1ogzk/manifest.json'} <= keys)
        self.assertEqual(len(got), 4 + max(20, int(498 * m.SKIP_SAMPLE_RATE)))
        self.assertEqual(len(keys), len(got))  # 没有重复

    def test_cos_etag(self):
        import io as _io
        import urllib.error
        from unittest import mock
        env = {'COS_SECRET_ID': 'id', 'COS_SECRET_KEY': 'k', 'COS_BUCKET': 'b-1', 'COS_REGION': 'ap-shanghai'}
        ok = mock.MagicMock()
        ok.__enter__.return_value.headers = {'ETag': '"ABCDEF0123"'}
        nf = urllib.error.HTTPError('u', 404, 'nf', {}, _io.BytesIO(b''))
        with mock.patch.dict(os.environ, env), mock.patch.object(m.time, 'sleep'):
            with mock.patch.object(m.urllib.request, 'urlopen', side_effect=[ok]):
                self.assertEqual(m.Cos().etag('iiif/x.webp'), 'abcdef0123')
            with mock.patch.object(m.urllib.request, 'urlopen', side_effect=[nf]):
                self.assertIsNone(m.Cos().etag('iiif/x.webp'))

    def test_commons_thumb_strips_tracking_query(self):
        cf_ = {'url': 'https://upload.wikimedia.org/wikipedia/commons/8/86/X.djvu'
                      '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original'}
        self.assertEqual(m.commons_thumb(cf_, 10),
                         'https://upload.wikimedia.org/wikipedia/commons/thumb/8/86/X.djvu/page10-1280px-X.djvu.jpg')

    def test_http_get_retries_incomplete_read(self):
        # 10-05 第一批核对：EdgeOne 偶发读到 0 字节就断（IncompleteRead），要重试而不是直接判失败
        import http.client
        from unittest import mock
        ok = mock.MagicMock()
        ok.__enter__.return_value.read.return_value = b'webp'
        ok.__enter__.return_value.headers = {'Content-Type': 'image/webp'}
        with mock.patch.object(m.urllib.request, 'urlopen',
                               side_effect=[http.client.IncompleteRead(b'', 398), ok]), \
                mock.patch.object(m.time, 'sleep'):
            body, hdr = m.http_get('https://data.kaiyuanguji.com/x', tries=3)
        self.assertEqual(body, b'webp')

    def test_cos_put_retries_when_error_body_truncated(self):
        import http.client
        import io as _io
        import urllib.error
        from unittest import mock
        err = urllib.error.HTTPError('u', 503, 'busy', {}, _io.BytesIO(b''))
        err.read = mock.Mock(side_effect=http.client.IncompleteRead(b'', 100))
        ok = mock.MagicMock()
        env = {'COS_SECRET_ID': 'id', 'COS_SECRET_KEY': 'k', 'COS_BUCKET': 'b-1', 'COS_REGION': 'ap-shanghai'}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(m.urllib.request, 'urlopen', side_effect=[err, ok]) as uo, \
                mock.patch.object(m.time, 'sleep'):
            m.Cos().put('iiif/x.webp', b'x', 'image/webp', 'public')
        self.assertEqual(uo.call_count, 2)

    def test_commons_pagecount_mismatch_dropped(self):
        meta = {'ia': '06061302.cn', 'leaves': 107, 'juan': ''}
        self.assertIsNone(m.usable_commons(3, meta, {'name': 'X', 'url': 'u', 'pagecount': 110}))


if __name__ == '__main__':
    unittest.main()
