#!/usr/bin/env python3
"""后台「文本整理」栏目的数据同步（A41，2026-10-25）。设计与写入约定见 docs/text-progress.md。

数据放 Neon 中心库的 progress schema（ops/text-progress/schema.sql）：各领域 job 往里写，网站只读。
网站在国内 EdgeOne 上，不直连 Neon（ai-team `通用/中心库设计.md` 第一节「不做的事」），所以由定时任务把表导出成
一份快照，POST 到本站 `/api/text-progress`（存 FEEDBACK_KV），后台页 /admin/text 读它。

子命令：
  init     建 progress schema（幂等；正式库上跑之前要用户点头）
  collect  基础采集：从现成真源算出每册的基本字段，软写进 progress.volume（别的写入方写过的字段不碰）
             - 中心库 books（册 yaml：cv_version、corpus、glyph_pin、freeze）
             - 中心库 files 里的待审单 feedback/lists/proofing/<书>/<章>.pending.json（rev、格数、出单时间）
             - book-text 各书 manifest.json 与原创版本 index.json（文本、标点、专名三线版本，proofing 开关）
  export   读 progress.* 出快照 JSON：--out 写文件，--put <站点> 传到 <站点>/api/text-progress

连库：--dsn，或环境变量 PROGRESS_DATABASE_URL、GUJI_DATA_PG_DSN（依次）。GitHub 的机器能直连 5432；
只通 443 的云会话先按 open-guji-cv `doc/datastore.md` 第一节起 wsbridge，再把桥的连接串给 GUJI_DATA_PG_DSN。
collect --from-worker：真源改经 guji-data Worker 读（GUJI_DATA_URL、GUJI_DATA_TOKEN，读令牌即可），写库照旧要连库；
配 --dry-run 时完全不连库，只把要写的行打出来（--out 写文件）。
令牌、连接串只从环境变量或参数读，不打印。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA_SQL = HERE / 'schema.sql'
SNAPSHOT_SCHEMA = 'text-progress/1'
COLLECTOR = 'web-collector'          # 基础采集在 field_meta 里的写入方名
BOOK_TEXT_RAW = 'https://raw.githubusercontent.com/open-guji/book-text/main'
DEFAULT_DATA_URL = 'https://data.open-guji.com'
PROOFING_PREFIX = 'feedback/lists/proofing/'

RE_BOOK_ID = re.compile(r'^[0-9a-z]{10}$')
RE_PENDING = re.compile(r'^feedback/lists/proofing/([0-9a-z]{4,24})/([A-Za-z0-9._-]{1,16})\.pending\.json$')
RE_CV_VOL = re.compile(r'^vol(\d{1,3})$')
# 不是书的工作区：共享语料底库、共享刻例库
SHARED_WS = re.compile(r'^(corpus-base|glyphlib-.*)$')

# 基础采集负责的字段：每次都整套写（真源里没有的写 null，比如待审单撤了，待人审格数就清空），
# 别的写入方一旦写过其中某个字段，采集就不再碰它（软写）
COLLECTOR_FIELDS = (
    'book_title', 'vol_title', 'vol_order', 'ws', 'cv_book',
    'text_version', 'punct_version', 'entity_version', 'proofing', 'frozen_version',
    'cv_version', 'corpus', 'glyph_pin', 'pending_review', 'pending_rev', 'pending_at',
)

# progress.volume 可写字段（与 schema.sql put_volume 的 allowed 一致）
VOLUME_FIELDS = (
    'book_title', 'vol_title', 'vol_order', 'ws', 'cv_book', 'stage',
    'text_version', 'punct_version', 'entity_version', 'proofing', 'frozen_version',
    'cv_version', 'corpus', 'glyph_pin', 'cells_total', 'pending_review', 'human_judged',
    'pending_rev', 'pending_at', 'punct_status', 'note', 'extra',
)


# ─── 纯函数（单测 ops/tests/test_text_progress.py） ─────────────────────────

def book_of_workspace(ws: str, dir_name: str | None) -> tuple[str, str | None]:
    """工作区 → (套书 id, 套书名)。目录名形如 `<book-index id>-<书名>`；不是这个形状的，id 用工作区 id 顶、书名给 None
    （由册 yaml 的 title 补）。"""
    d = dir_name or ''
    m = re.match(r'^([0-9a-z]{10})-(.+)$', d)
    if m:
        return m.group(1), m.group(2)
    return ws, None


def vol_of_cv_book(cv_book: str) -> str:
    """cv 册 id → 册号：`vol05` → `005`（与 book-text 章号、待审单 <章> 同口径）；别的形状原样。"""
    m = RE_CV_VOL.match(cv_book or '')
    return m.group(1).zfill(3) if m else cv_book


def book_text_dir(book_id: str) -> str:
    """book-text 里一部书的目录：`Book/<倒数第三>/<倒数第二>/<末位>/<id>`（如 96mid1ogzk → Book/g/z/k/96mid1ogzk）。"""
    return f'Book/{book_id[-3]}/{book_id[-2]}/{book_id[-1]}/{book_id}'


def vol_order_of(vol: str) -> int | None:
    return int(vol) if vol.isdigit() else None


def _str_or_none(v) -> str | None:
    return None if v is None or v == '' else str(v)


def split_yaml_title(title: str | None, cv_book: str) -> tuple[str | None, str | None]:
    """册 yaml 的 title（如 `欽定四庫全書總目·經部·禮類三~四·卷二十一~二十二（vol11）`）→ (书名段, 本册段)。

    去掉末尾的 `（<cv 册 id>）`；有「·」的，第一段是书名、其余是本册；没有的整个当本册（如北行日録只有一册）。
    """
    t = (title or '').strip()
    t = re.sub(r'（' + re.escape(cv_book) + r'）$', '', t).strip() if cv_book else t
    if not t:
        return None, None
    head, sep, rest = t.partition('·')
    return (head, rest) if sep and rest else (None, t)


def volume_from_book_yaml(ws: str, book_id: str, book_title: str | None, cv_book: str, title: str | None,
                          doc: dict | None) -> dict:
    """册 yaml（中心库 books 一行）→ 基本字段。book_title 给 None 时用 title 的书名段。"""
    doc = doc if isinstance(doc, dict) else {}
    freeze = doc.get('freeze') if isinstance(doc.get('freeze'), dict) else {}
    vol = vol_of_cv_book(cv_book)
    head, part = split_yaml_title(title, cv_book)
    return {
        'book_id': book_id, 'vol': vol,
        'fields': {
            'book_title': book_title or head,
            'vol_title': part,
            'vol_order': vol_order_of(vol),
            'ws': ws,
            'cv_book': cv_book,
            'cv_version': _str_or_none(doc.get('cv_version') or freeze.get('cv_version')),
            'corpus': _str_or_none(doc.get('corpus')),
            'glyph_pin': _str_or_none(doc.get('glyph_pin')),
            'frozen_version': _str_or_none(freeze.get('at')),
        },
    }


def summarize_pending(doc: dict) -> dict:
    """待审单 JSON → 计数。格数就是待人审格数（单里只列待审格）；按 audience（public／team）、cls（原因类）分。"""
    cells = doc.get('cells') if isinstance(doc.get('cells'), list) else []
    by_aud: dict[str, int] = {}
    by_cls: dict[str, int] = {}
    for c in cells:
        if not isinstance(c, dict):
            continue
        a = str(c.get('audience') or 'public')
        by_aud[a] = by_aud.get(a, 0) + 1
        k = str(c.get('cls') or 'other')
        by_cls[k] = by_cls.get(k, 0) + 1
    return {
        'rev': _str_or_none(doc.get('rev')), 'n': len(cells), 'cv_version': _str_or_none(doc.get('cv_version')),
        'routed_as_of': _str_or_none(doc.get('routed_as_of')), 'audience': by_aud, 'cls': by_cls,
    }


def volume_from_pending(book_id: str, chap: str, s: dict) -> dict:
    return {
        'book_id': book_id, 'vol': chap,
        'fields': {
            'pending_review': s['n'],
            'pending_rev': s['rev'],
            'pending_at': s['routed_as_of'],
            'extra': {'web.pending_audience': s['audience'], 'web.pending_cls': s['cls'],
                      'web.pending_cv_version': s['cv_version']},
        },
    }


def volumes_from_book_text(book_id: str, manifest: dict, indexes: dict[str, dict]) -> list[dict]:
    """book-text 一部书 → 每章一行：三线版本、proofing、标题。

    只看原创版本（manifest versions[] 里 is_original 或 source=original，即本项目自己整理的文本）。
    同一章在几个原创版本里都有时（如 default 1.0.3 与 cv-proof 粗校 0.1.1），default（没有就第一个）为准，
    其余记进 extra['web.text_versions']。
    """
    keys = [v.get('key') for v in (manifest.get('versions') or [])
            if isinstance(v, dict) and v.get('key') and (v.get('is_original') or v.get('source') == 'original')]
    keys.sort(key=lambda k: k != 'default')  # 稳定排序：default 提前，其余保持 manifest 里的顺序
    out: dict[str, dict] = {}
    for key in keys:
        idx = indexes.get(key)
        if not isinstance(idx, dict):
            continue
        for ch in idx.get('chapters') or []:
            if not isinstance(ch, dict) or not ch.get('file'):
                continue
            vol = str(ch['file'])
            row = out.get(vol)
            if row is None:
                row = out[vol] = {
                    'book_id': book_id, 'vol': vol,
                    'fields': {
                        'text_version': _str_or_none(ch.get('text_version')),
                        'punct_version': _str_or_none(ch.get('punct_version')),
                        'entity_version': _str_or_none(ch.get('entity_version')),
                        'proofing': ch.get('proofing') is True,
                        'vol_order': vol_order_of(vol) if ch.get('n') is None else int(ch['n']),
                        'extra': {'web.text_versions': {}},
                    },
                    'title': _str_or_none(ch.get('title')),
                }
            row['fields']['extra']['web.text_versions'][key] = _str_or_none(ch.get('text_version'))
    return list(out.values())


def merge_rows(*groups: list[dict]) -> list[dict]:
    """几路来源的行按 (book_id, vol) 合并：后来的字段覆盖前面的，extra 浅合并。
    行上的 `title`（book-text 章标题，网站阅读页显示的就是它）优先于字段里的 vol_title（册 yaml）。"""
    merged: dict[tuple[str, str], dict] = {}
    for rows in groups:
        for r in rows:
            k = (r['book_id'], r['vol'])
            cur = merged.setdefault(k, {'book_id': r['book_id'], 'vol': r['vol'], 'fields': {}})
            for f, v in r['fields'].items():
                if f == 'extra':
                    cur['fields']['extra'] = {**cur['fields'].get('extra', {}), **v}
                else:
                    cur['fields'][f] = v
            if r.get('title'):
                cur['text_title'] = r['title']
    for cur in merged.values():
        t = cur.pop('text_title', None)
        if t:
            cur['fields']['vol_title'] = t
    return [merged[k] for k in sorted(merged)]


def collect_rows(workspaces: list[dict], books: list[dict], pendings: list[dict],
                 book_text: dict[str, tuple[dict, dict[str, dict]]]) -> tuple[list[dict], list[str]]:
    """三路真源 → 要软写的行与问题清单。

    workspaces: [{ws, dir}]；books: [{ws, book, title, doc}]；pendings: [{ws, src_path, summary}]
    book_text: {book_id: (manifest, {版本 key: index.json})}
    """
    problems: list[str] = []
    ws_book: dict[str, tuple[str, str]] = {}
    for w in workspaces:
        if SHARED_WS.match(w['ws']):
            continue
        ws_book[w['ws']] = book_of_workspace(w['ws'], w.get('dir'))
    from_yaml = []
    for b in books:
        if b['ws'] not in ws_book:
            continue
        book_id, book_title = ws_book[b['ws']]
        from_yaml.append(volume_from_book_yaml(b['ws'], book_id, book_title, b['book'], b.get('title'), b.get('doc')))
    from_pending = []
    for p in pendings:
        m = RE_PENDING.match(p['src_path'])
        if not m:
            problems.append(f"待审单路径不认识：{p['ws']}:{p['src_path']}")
            continue
        from_pending.append(volume_from_pending(m.group(1), m.group(2), p['summary']))
    from_text = []
    for book_id, (manifest, indexes) in sorted(book_text.items()):
        from_text.extend(volumes_from_book_text(book_id, manifest, indexes))
    rows = merge_rows(from_text, from_yaml, from_pending)
    # 套书名：册 yaml 那路有；只在 book-text 里出现的册补上同一部书的名字
    titles = {r['book_id']: r['fields'].get('book_title') for r in rows if r['fields'].get('book_title')}
    for r in rows:
        if not r['fields'].get('book_title') and titles.get(r['book_id']):
            r['fields']['book_title'] = titles[r['book_id']]
        for f in COLLECTOR_FIELDS:
            r['fields'].setdefault(f, None)
    return rows, problems


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    return str(v)


def build_snapshot(volumes: list[dict], sections: list[dict], metrics: list[dict], meta: dict[str, str],
                   now: dt.datetime | None = None) -> dict:
    """progress.* 的行 → 后台页读的快照（键排序稳定，时间一律 ISO 字符串）。"""
    now = now or dt.datetime.now(dt.timezone.utc)
    vols = []
    for v in volumes:
        row = {k: _iso(v.get(k)) if k in ('pending_at', 'updated_at') else v.get(k) for k in
               ('book_id', 'vol', *[f for f in VOLUME_FIELDS if f != 'extra'], 'updated_at')}
        row['extra'] = v.get('extra') or {}
        row['field_meta'] = v.get('field_meta') or {}
        vols.append(row)
    vols.sort(key=lambda r: (r['book_id'], r['vol_order'] if r['vol_order'] is not None else 10**9, r['vol']))
    secs = sorted(({k: s.get(k) for k in ('section', 'title', 'owner', 'description', 'sort')} for s in sections),
                  key=lambda s: (s['sort'], s['section']))
    mets = sorted(({**{k: m.get(k) for k in ('book_id', 'vol', 'section', 'key', 'label', 'value', 'value_text',
                                               'unit', 'detail', 'sort', 'writer')}, 'at': _iso(m.get('at'))}
                   for m in metrics),
                  key=lambda m: (m['section'], m['book_id'], m['vol'], m['sort'], m['key']))
    last_run = None
    if meta.get('collector.last_run'):
        try:
            last_run = json.loads(meta['collector.last_run'])
        except ValueError:
            last_run = None
    return {
        'schema': SNAPSHOT_SCHEMA,
        'generated_at': now.isoformat(),
        'schema_version': meta.get('schema_version'),
        'collector': last_run,
        'volumes': vols,
        'sections': secs,
        'metrics': mets,
    }


# ─── 取数 ────────────────────────────────────────────────────────────────────

def http_json(url: str, headers: dict | None = None, timeout: float = 60.0, allow404: bool = False):
    req = urllib.request.Request(url, headers={'User-Agent': 'kaiyuanguji-text-progress', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if allow404 and e.code == 404:
            return None
        raise


def fetch_book_text(book_ids: list[str], base: str = BOOK_TEXT_RAW) -> tuple[dict, list[str]]:
    out: dict[str, tuple[dict, dict[str, dict]]] = {}
    problems: list[str] = []
    for bid in book_ids:
        if not RE_BOOK_ID.match(bid):
            continue
        d = book_text_dir(bid)
        manifest = http_json(f'{base}/{d}/manifest.json', allow404=True)
        if manifest is None:
            continue  # 这部书还没进 book-text
        indexes = {}
        for v in manifest.get('versions') or []:
            key = v.get('key') if isinstance(v, dict) else None
            if not key or not (v.get('is_original') or v.get('source') == 'original'):
                continue
            idx = http_json(f'{base}/{d}/{urllib.parse.quote(key)}/index.json', allow404=True)
            if idx is None:
                problems.append(f'book-text {bid}/{key}/index.json 取不到')
                continue
            indexes[key] = idx
        out[bid] = (manifest, indexes)
    return out, problems


class PgTruth:
    """真源直接从中心库 Postgres 读（GitHub 定时任务用）。待审单的计数在库里算，不把几 MB 的单子拉回来。"""

    def __init__(self, conn):
        self.conn = conn

    def workspaces(self):
        with self.conn.cursor() as cur:
            cur.execute('SELECT ws, dir FROM public.workspaces ORDER BY ws')
            return [{'ws': a, 'dir': b} for a, b in cur.fetchall()]

    def books(self):
        with self.conn.cursor() as cur:
            cur.execute('SELECT ws, book, title, doc FROM public.books ORDER BY ws, book')
            return [{'ws': a, 'book': b, 'title': c, 'doc': d} for a, b, c, d in cur.fetchall()]

    def pendings(self):
        sql = """
        SELECT ws, src_path, j->>'rev', j->>'cv_version', j->>'routed_as_of',
               (SELECT coalesce(jsonb_object_agg(a, n), '{}'::jsonb) FROM (
                   SELECT coalesce(c->>'audience', 'public') a, count(*) n FROM jsonb_array_elements(j->'cells') c GROUP BY 1) t),
               (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (
                   SELECT coalesce(c->>'cls', 'other') k, count(*) n FROM jsonb_array_elements(j->'cells') c GROUP BY 1) t),
               jsonb_array_length(j->'cells')
          FROM (SELECT ws, src_path, coalesce(doc, raw::jsonb) j FROM public.files
                 WHERE src_path LIKE 'feedback/lists/proofing/%.pending.json') f
         WHERE jsonb_typeof(j->'cells') = 'array'
         ORDER BY ws, src_path"""
        with self.conn.cursor() as cur:
            cur.execute(sql)
            return [{'ws': ws, 'src_path': p, 'summary': {
                'rev': rev, 'cv_version': cvv, 'routed_as_of': at, 'audience': aud or {}, 'cls': cls or {}, 'n': n}}
                for ws, p, rev, cvv, at, aud, cls, n in cur.fetchall()]


class WorkerTruth:
    """真源经 guji-data Worker 读（只通 443、手上只有读令牌的会话用；待审单要整份拉回来数）。"""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip('/')
        self.h = {'Authorization': f'Bearer {token}'}

    def _get(self, path: str, **q):
        return http_json(f'{self.url}{path}?{urllib.parse.urlencode({"branch": "main", **q})}', self.h, timeout=120)

    def _table(self, table: str, cols: str):
        rows, after = [], None
        while True:
            q = {'cols': cols, 'limit': 1000, **({'after': after} if after else {})}
            page = self._get(f'/v1/tables/{table}', **q)
            rows.extend(page.get('rows') or [])
            after = page.get('next')
            if not after:
                return rows

    def workspaces(self):
        return [{'ws': r['ws'], 'dir': r.get('dir')} for r in self._table('workspaces', 'ws,dir')]

    def books(self):
        return [{'ws': r['ws'], 'book': r['book'], 'title': r.get('title'), 'doc': r.get('doc')}
                for r in self._table('books', 'ws,book,title,doc')]

    def pendings(self):
        out = []
        for w in self.workspaces():
            if SHARED_WS.match(w['ws']):
                continue
            listing = self._get('/v1/files', ws=w['ws'], prefix=PROOFING_PREFIX)
            for f in listing.get('files') or []:
                if not f['src_path'].endswith('.pending.json'):
                    continue
                got = self._get('/v1/files', ws=w['ws'], src_path=f['src_path'])
                try:
                    doc = json.loads(got.get('text') or '')
                except ValueError:
                    continue
                out.append({'ws': w['ws'], 'src_path': f['src_path'], 'summary': summarize_pending(doc)})
        return out


# ─── 连库与子命令 ────────────────────────────────────────────────────────────

def connect(dsn: str | None):
    dsn = dsn or os.environ.get('PROGRESS_DATABASE_URL') or os.environ.get('GUJI_DATA_PG_DSN')
    if not dsn:
        raise SystemExit('要连库：--dsn，或设 PROGRESS_DATABASE_URL／GUJI_DATA_PG_DSN')
    import psycopg  # 只有连库的子命令要它：pip install 'psycopg[binary]'
    return psycopg.connect(dsn)


def cmd_init(args) -> int:
    with connect(args.dsn) as conn:
        conn.execute(SCHEMA_SQL.read_text(encoding='utf-8'))
        conn.commit()
    print('✓ progress schema 已建好（幂等）')
    return 0


def cmd_collect(args) -> int:
    started = dt.datetime.now(dt.timezone.utc)
    conn = None
    if args.from_worker:
        token = os.environ.get('GUJI_DATA_TOKEN') or os.environ.get('GUJI_DATA_TOKEN_READ')
        if not token:
            raise SystemExit('--from-worker 要 GUJI_DATA_TOKEN（读令牌即可）')
        truth = WorkerTruth(os.environ.get('GUJI_DATA_URL') or DEFAULT_DATA_URL, token)
    else:
        conn = connect(args.dsn)
        truth = PgTruth(conn)
    workspaces, books, pendings = truth.workspaces(), truth.books(), truth.pendings()
    ids = sorted({book_of_workspace(w['ws'], w.get('dir'))[0] for w in workspaces if not SHARED_WS.match(w['ws'])})
    book_text, problems = fetch_book_text(ids, args.book_text_base)
    rows, more = collect_rows(workspaces, books, pendings, book_text)
    problems += more
    print(f'· 工作区 {len(workspaces)}、册 yaml {len(books)}、待审单 {len(pendings)}、book-text 书 {len(book_text)} → {len(rows)} 册')
    for p in problems:
        print(f'  ⚠ {p}')
    if args.out:
        Path(args.out).write_text(json.dumps({'rows': rows, 'problems': problems}, ensure_ascii=False, indent=1), encoding='utf-8')
    if args.dry_run:
        print('· dry-run：不写库')
        return 0
    if conn is None:
        conn = connect(args.dsn)
    written = 0
    with conn:
        with conn.cursor() as cur:
            for r in rows:
                cur.execute('SELECT progress.put_volume(%s, %s, %s::jsonb, %s, true)',
                            (r['book_id'], r['vol'], json.dumps(r['fields'], ensure_ascii=False), COLLECTOR))
                written += len(cur.fetchone()[0] or [])
            run = {'at': started.isoformat(), 'finished_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'volumes': len(rows), 'fields_written': written, 'problems': problems[:50],
                   'source': 'worker' if args.from_worker else 'postgres'}
            cur.execute("INSERT INTO progress.meta (key, value) VALUES ('collector.last_run', %s) "
                        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (json.dumps(run, ensure_ascii=False),))
    print(f'✓ 软写 {len(rows)} 册，共 {written} 个字段')
    return 0


def read_snapshot(conn) -> dict:
    with conn.cursor() as cur:
        cols = ['book_id', 'vol', *VOLUME_FIELDS, 'field_meta', 'updated_at']
        cur.execute(f"SELECT {', '.join(cols)} FROM progress.volume")
        volumes = [dict(zip(cols, r)) for r in cur.fetchall()]
        cur.execute('SELECT section, title, owner, description, sort FROM progress.section')
        sections = [dict(zip(('section', 'title', 'owner', 'description', 'sort'), r)) for r in cur.fetchall()]
        mcols = ['book_id', 'vol', 'section', 'key', 'label', 'value', 'value_text', 'unit', 'detail', 'sort', 'writer', 'at']
        cur.execute(f"SELECT {', '.join(mcols)} FROM progress.metric")
        metrics = [dict(zip(mcols, r)) for r in cur.fetchall()]
        cur.execute('SELECT key, value FROM progress.meta')
        meta = dict(cur.fetchall())
    return build_snapshot(volumes, sections, metrics, meta)


def put_snapshot(site: str, token: str, snap: dict) -> dict:
    body = json.dumps(snap, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(f"{site.rstrip('/')}/api/text-progress", data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': f'Bearer {token}', 'User-Agent': 'kaiyuanguji-text-progress'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


def cmd_export(args) -> int:
    with connect(args.dsn) as conn:
        snap = read_snapshot(conn)
    print(f"· 快照：{len(snap['volumes'])} 册、{len(snap['sections'])} 个栏目、{len(snap['metrics'])} 个数")
    if args.out:
        Path(args.out).write_text(json.dumps(snap, ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'✓ 写到 {args.out}')
    if args.put:
        token = os.environ.get('FEEDBACK_ADMIN_TOKEN')
        if not token:
            raise SystemExit('--put 要 FEEDBACK_ADMIN_TOKEN（网站管理令牌）')
        res = put_snapshot(args.put, token, snap)
        if not res.get('success'):
            raise SystemExit(f"✗ 上传失败：{res.get('error')}")
        print(f"✓ 已传到 {args.put}/api/text-progress（{res.get('bytes')} 字节）")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dsn', help='连接串（缺省读 PROGRESS_DATABASE_URL、GUJI_DATA_PG_DSN）')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('init', help='建 progress schema（幂等）')
    c = sub.add_parser('collect', help='基础采集，软写 progress.volume')
    c.add_argument('--from-worker', action='store_true', help='真源经 guji-data Worker 读（读令牌）')
    c.add_argument('--dry-run', action='store_true', help='不写库')
    c.add_argument('--out', help='把要写的行写成 JSON 文件')
    c.add_argument('--book-text-base', default=BOOK_TEXT_RAW, help='book-text 原文地址前缀（测试用）')
    e = sub.add_parser('export', help='读 progress.* 出快照')
    e.add_argument('--out', help='快照写文件')
    e.add_argument('--put', help='传到这个站点的 /api/text-progress（如 https://www.openguji.com）')
    args = ap.parse_args(argv)
    return {'init': cmd_init, 'collect': cmd_collect, 'export': cmd_export}[args.cmd](args)


if __name__ == '__main__':
    sys.exit(main())
