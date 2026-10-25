"""ops/text-progress/sync.py 的纯函数：真源 → 每册基本字段、快照形状（不连库、不连网）。"""
import datetime as dt
import importlib.util
import json
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location('tp_sync', Path(__file__).resolve().parents[1] / 'text-progress' / 'sync.py')
tp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tp)

WORKSPACES = [
    {'ws': 'siku-zongmu', 'dir': '96mid1ogzk-欽定四庫全書總目武英殿刻本'},
    {'ws': 'qtw-draft', 'dir': 'qtw-draft'},
    {'ws': 'corpus-base', 'dir': 'corpus-base'},
    {'ws': 'glyphlib-qkp-v1', 'dir': 'glyphlib-qkp-v1'},
]
BOOKS = [
    {'ws': 'siku-zongmu', 'book': 'vol05', 'title': '欽定四庫全書總目·經部八~九·易類存目·卷八~卷九（vol05）',
     'doc': {'cv_version': '0.5.7', 'corpus': 15, 'glyph_pin': 1,
             'freeze': {'at': '1.0.1', 'cv_version': '0.5.7'}}},
    {'ws': 'siku-zongmu', 'book': 'vol11', 'title': '欽定四庫全書總目·經部·禮類三~四·卷二十一~二十二（vol11）',
     'doc': {'corpus': 18}},
    {'ws': 'qtw-draft', 'book': 'v006', 'title': '欽定全唐文·CADAL CADAL01022804·卷1~2（v006）', 'doc': {}},
    {'ws': 'corpus-base', 'book': 'x', 'title': 'x', 'doc': {}},
]
PENDINGS = [
    {'ws': 'siku-zongmu', 'src_path': 'feedback/lists/proofing/96mid1ogzk/011.pending.json',
     'summary': tp.summarize_pending({'rev': '011-r0', 'cv_version': '0.5.12', 'routed_as_of': '2026-10-22T23:48:11Z',
                                      'cells': [{'cls': 'near_form'}, {'cls': 'near_form', 'audience': 'team'}, {}]})},
    {'ws': 'siku-zongmu', 'src_path': 'feedback/lists/proofing/oops.json', 'summary': {}},
]
MANIFEST = {'versions': [
    {'key': 'cv-proof', 'source': 'original'},
    {'key': 'default', 'is_original': True},
    {'key': 'wiki', 'source': 'wikisource'},
]}
INDEXES = {
    'default': {'chapters': [
        {'n': 5, 'file': '005', 'title': '易類存目二至三', 'text_version': '1.0.1', 'punct_version': '1.0.0', 'entity_version': '1.0.0'},
        {'n': 11, 'file': '011', 'title': '禮類三至四', 'text_version': '0.1.0', 'proofing': True},
    ]},
    'cv-proof': {'chapters': [{'n': 5, 'file': '005', 'title': '粗校本', 'text_version': '0.1.1', 'proofing': True}]},
    'wiki': {'chapters': [{'file': '099', 'text_version': '9.9.9'}]},
}


class TestPure(unittest.TestCase):
    def test_book_of_workspace(self):
        self.assertEqual(tp.book_of_workspace('siku-zongmu', '96mid1ogzk-欽定四庫全書總目武英殿刻本'),
                         ('96mid1ogzk', '欽定四庫全書總目武英殿刻本'))
        self.assertEqual(tp.book_of_workspace('qtw-draft', 'qtw-draft'), ('qtw-draft', None))

    def test_vol_and_dir(self):
        self.assertEqual(tp.vol_of_cv_book('vol05'), '005')
        self.assertEqual(tp.vol_of_cv_book('bxgb'), 'bxgb')
        self.assertEqual(tp.book_text_dir('96mid1ogzk'), 'Book/g/z/k/96mid1ogzk')

    def test_split_yaml_title(self):
        self.assertEqual(tp.split_yaml_title('欽定四庫全書總目·經部·禮類三~四（vol11）', 'vol11'), ('欽定四庫全書總目', '經部·禮類三~四'))
        self.assertEqual(tp.split_yaml_title('北行日録（知不足齋叢書刻本）', 'bxgb'), (None, '北行日録（知不足齋叢書刻本）'))
        self.assertEqual(tp.split_yaml_title(None, 'x'), (None, None))

    def test_summarize_pending(self):
        s = PENDINGS[0]['summary']
        self.assertEqual(s['n'], 3)
        self.assertEqual(s['audience'], {'public': 2, 'team': 1})
        self.assertEqual(s['cls'], {'near_form': 2, 'other': 1})

    def test_book_text_default_wins(self):
        rows = {r['vol']: r for r in tp.volumes_from_book_text('96mid1ogzk', MANIFEST, INDEXES)}
        self.assertEqual(set(rows), {'005', '011'})  # wiki 不是原创版本，不收
        self.assertEqual(rows['005']['fields']['text_version'], '1.0.1')
        self.assertFalse(rows['005']['fields']['proofing'])
        self.assertEqual(rows['005']['fields']['extra']['web.text_versions'], {'default': '1.0.1', 'cv-proof': '0.1.1'})
        self.assertEqual(rows['005']['title'], '易類存目二至三')

    def test_collect_rows(self):
        rows, problems = tp.collect_rows(WORKSPACES, BOOKS, PENDINGS, {'96mid1ogzk': (MANIFEST, INDEXES)})
        by = {(r['book_id'], r['vol']): r['fields'] for r in rows}
        self.assertEqual(set(by), {('96mid1ogzk', '005'), ('96mid1ogzk', '011'), ('qtw-draft', 'v006')})
        self.assertEqual(problems, ['待审单路径不认识：siku-zongmu:feedback/lists/proofing/oops.json'])
        v5 = by[('96mid1ogzk', '005')]
        self.assertEqual((v5['cv_version'], v5['corpus'], v5['glyph_pin'], v5['frozen_version']), ('0.5.7', '15', '1', '1.0.1'))
        self.assertEqual(v5['vol_title'], '易類存目二至三')  # book-text 章标题优先
        self.assertEqual(v5['book_title'], '欽定四庫全書總目武英殿刻本')
        self.assertIsNone(v5['pending_review'])  # 没有待审单：采集负责的字段写 null（清掉旧值）
        v11 = by[('96mid1ogzk', '011')]
        self.assertEqual((v11['pending_review'], v11['pending_rev'], v11['text_version']), (3, '011-r0', '0.1.0'))
        self.assertEqual(v11['extra']['web.pending_cls'], {'near_form': 2, 'other': 1})
        q = by[('qtw-draft', 'v006')]
        self.assertEqual((q['book_title'], q['vol_title'], q['vol_order']), ('欽定全唐文', 'CADAL CADAL01022804·卷1~2', None))
        for f in tp.COLLECTOR_FIELDS:
            self.assertIn(f, q)
        self.assertTrue(set(tp.COLLECTOR_FIELDS) <= set(tp.VOLUME_FIELDS))

    def test_build_snapshot(self):
        at = dt.datetime(2026, 10, 25, 4, 0, tzinfo=dt.timezone.utc)
        snap = tp.build_snapshot(
            volumes=[{'book_id': 'b', 'vol': '010', 'vol_order': 10, 'pending_at': at, 'updated_at': at, 'extra': None},
                     {'book_id': 'b', 'vol': '002', 'vol_order': 2, 'updated_at': at},
                     {'book_id': 'a', 'vol': 'x', 'updated_at': at}],
            sections=[{'section': 'review', 'title': '人审', 'sort': 30}, {'section': 'xingjin', 'title': '形近字', 'sort': 10}],
            metrics=[{'book_id': '', 'vol': '', 'section': 'review', 'key': 'k', 'label': 'l', 'value': 1.0, 'writer': 'A32', 'at': at}],
            meta={'schema_version': '1', 'collector.last_run': json.dumps({'at': 'x', 'problems': []})}, now=at)
        self.assertEqual(snap['schema'], 'text-progress/1')
        self.assertEqual([(v['book_id'], v['vol']) for v in snap['volumes']], [('a', 'x'), ('b', '002'), ('b', '010')])
        self.assertEqual(snap['volumes'][2]['pending_at'], '2026-10-25T04:00:00+00:00')
        self.assertEqual(snap['volumes'][2]['extra'], {})
        self.assertEqual([s['section'] for s in snap['sections']], ['xingjin', 'review'])
        self.assertEqual(snap['metrics'][0]['at'], '2026-10-25T04:00:00+00:00')
        self.assertEqual(snap['collector'], {'at': 'x', 'problems': []})
        json.dumps(snap)  # 能序列化

    def test_schema_fields_match(self):
        """schema.sql 里 put_volume 的可写字段与脚本一致"""
        sql = (Path(tp.__file__).parent / 'schema.sql').read_text(encoding='utf-8')
        block = sql.split('allowed CONSTANT text[] := ARRAY[', 1)[1].split('];', 1)[0]
        self.assertEqual(tuple(x.strip().strip("'") for x in block.replace('\n', ' ').split(',')), tp.VOLUME_FIELDS)


if __name__ == '__main__':
    unittest.main()
