-- 文本整理进度（后台「文本整理」栏目，A41，2026-10-25）：Neon 中心库的 progress schema。
-- 设计与写入约定见 docs/text-progress.md。幂等，可反复执行（ops/text-progress/sync.py init）。
--
-- 谁写：各领域的 job 把算好的数写进来（A30–A34、A2x），网站的定时任务只读、导出到网站 KV 给后台页看。
-- 网站自己的「基础采集」（sync.py collect）也是一个写入方，只填从现成真源能直接拿到的字段（册 yaml、待审单、book-text 版本），
-- 用软写：某个字段一旦有别的写入方写过，采集就不再碰它（见 put_volume 的 p_soft）。
CREATE SCHEMA IF NOT EXISTS progress;

CREATE TABLE IF NOT EXISTS progress.meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- ─── 第一部分：一册一行 ──────────────────────────────────────────────────
-- 册的口径同网站与待审单：套书 = book-index 的 Book id，册 = book-text 的章号（三位，如 005；待审单路径 <书>/<章>）。
-- 没有 book-index id 的工作区（如 qtw-draft）book_id 写工作区 id，册写 cv 册 id。
CREATE TABLE IF NOT EXISTS progress.volume (
  book_id        text NOT NULL,
  vol            text NOT NULL,
  book_title     text,                 -- 套书名
  vol_title      text,                 -- 本册卷次、标题
  vol_order      integer,              -- 排序用；空则按 vol 排
  ws             text,                 -- cv 工作区 id（如 siku-zongmu）
  cv_book        text,                 -- cv 册 id（如 vol05）
  stage          text CHECK (stage IN ('todo', 'pipeline', 'rough', 'fine', 'released')),
                                       -- 未开工／跑管线／粗校／精校／已出 1.0；空则后台页按文本版本推断（标「推断」）
  text_version   text,                 -- 文本线版本（book-text 章条目 text_version，如 0.4.0）
  punct_version  text,                 -- 标点线版本
  entity_version text,                 -- 专名线版本
  proofing       boolean,              -- 章条目 proofing: true（精校页开着）
  frozen_version text,                 -- 冻结在哪一版（册 yaml freeze.at）；空＝未冻结
  cv_version     text,                 -- 本册固定的 cv 版本（不带 v）
  corpus         text,                 -- 语料库号
  glyph_pin      text,                 -- 字形库快照号
  cells_total    integer,              -- 全册格数
  pending_review integer,              -- 待人审格数（线上待审单的格数）
  human_judged   integer,              -- 已人裁格数
  pending_rev    text,                 -- 线上待审单的 rev（如 005-r10）
  pending_at     timestamptz,          -- 该单出单时间（routed_as_of）
  punct_status   text,                 -- 标点进度的一句话（如「试跑，未入库」）
  note           text,                 -- 备注（卡在哪、等谁）
  extra          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 其余附带信息（浅合并），后台页不逐项显示
  field_meta     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {字段: {"by": 写入方, "at": 时间}}，由 put_volume 维护
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, vol)
);

-- 写一册的若干字段。p_fields 只放要改的字段（值为 null ＝清空）；不认识的字段整次拒绝。
-- p_soft = true 时，已被别的写入方写过的字段跳过不写（网站基础采集用；领域 job 用缺省的 false）。
-- extra 浅合并（给了的键覆盖，没给的保留），不受 p_soft 限制：各写入方的键请带自己的前缀。返回实际写了的字段。
CREATE OR REPLACE FUNCTION progress.put_volume(
  p_book text, p_vol text, p_fields jsonb, p_by text, p_soft boolean DEFAULT false
) RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  allowed CONSTANT text[] := ARRAY[
    'book_title', 'vol_title', 'vol_order', 'ws', 'cv_book', 'stage',
    'text_version', 'punct_version', 'entity_version', 'proofing', 'frozen_version',
    'cv_version', 'corpus', 'glyph_pin', 'cells_total', 'pending_review', 'human_judged',
    'pending_rev', 'pending_at', 'punct_status', 'note', 'extra'];
  bad text[];
  meta jsonb;
  k text;
  written text[] := '{}';
BEGIN
  IF coalesce(p_book, '') = '' OR coalesce(p_vol, '') = '' THEN
    RAISE EXCEPTION 'book_id、vol 必填';
  END IF;
  IF coalesce(p_by, '') = '' THEN
    RAISE EXCEPTION 'by（写入方，如 A32 或 job 名）必填';
  END IF;
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'p_fields 必须是 JSON 对象';
  END IF;
  SELECT array_agg(f ORDER BY f) INTO bad FROM jsonb_object_keys(p_fields) AS f WHERE f <> ALL (allowed);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '不认识的字段：%（可写：%）', bad, allowed;
  END IF;
  IF p_fields ? 'extra' AND jsonb_typeof(p_fields -> 'extra') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION 'extra 必须是 JSON 对象';
  END IF;

  INSERT INTO progress.volume (book_id, vol) VALUES (p_book, p_vol) ON CONFLICT DO NOTHING;
  SELECT field_meta INTO meta FROM progress.volume WHERE book_id = p_book AND vol = p_vol FOR UPDATE;

  FOR k IN SELECT jsonb_object_keys(p_fields) LOOP
    IF p_soft AND k <> 'extra' AND meta ? k AND meta -> k ->> 'by' IS DISTINCT FROM p_by THEN
      CONTINUE;
    END IF;
    IF k = 'extra' THEN
      UPDATE progress.volume SET extra = extra || coalesce(p_fields -> 'extra', '{}'::jsonb)
       WHERE book_id = p_book AND vol = p_vol;
    ELSE
      -- 经 jsonb_populate_record 转成列的类型：类型不对（如 cells_total 给了 "abc"）在这里报错
      EXECUTE format(
        'UPDATE progress.volume v SET %1$I = r.%1$I FROM jsonb_populate_record(NULL::progress.volume, $1) r
          WHERE v.book_id = $2 AND v.vol = $3', k)
        USING p_fields, p_book, p_vol;
    END IF;
    meta := meta || jsonb_build_object(k, jsonb_build_object('by', p_by, 'at', now()));
    written := written || k;
  END LOOP;

  IF cardinality(written) > 0 THEN
    UPDATE progress.volume SET field_meta = meta, updated_at = now() WHERE book_id = p_book AND vol = p_vol;
  END IF;
  RETURN written;
END;
$$;

-- ─── 第二部分：各领域自己的数（形近字、异体字组、人审……） ──────────────
-- 栏目登记：后台页按这里的顺序给每个栏目留一块；领域要新开栏目就 INSERT 一行。
CREATE TABLE IF NOT EXISTS progress.section (
  section     text PRIMARY KEY CHECK (section ~ '^[a-z][a-z0-9_-]{0,31}$'),
  title       text NOT NULL,
  owner       text,                    -- 负责填数的领域，如 A24
  description text,                    -- 这一栏看什么、口径
  sort        integer NOT NULL DEFAULT 100
);

-- 一个数一行。vol = '' 表示整套书；book_id = '' 表示不分书（全局）。
-- 同一 (book_id, vol, section, key) 再写就覆盖（只留最新值；要看历史，写入方在 detail 里自带或另建表）。
CREATE TABLE IF NOT EXISTS progress.metric (
  book_id    text NOT NULL DEFAULT '',
  vol        text NOT NULL DEFAULT '',
  section    text NOT NULL REFERENCES progress.section (section),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  label      text NOT NULL,            -- 后台页显示的名字，如「形近字准确率」
  value      double precision,         -- 数值；比率写小数（0.973），unit 写 %
  value_text text,                     -- 不是数的写这里（如「试跑中」）
  unit       text,                     -- %、格、条、组……
  detail     jsonb,                    -- 明细（分母、样本、链接……），后台页不逐项显示
  sort       integer NOT NULL DEFAULT 100,
  writer     text NOT NULL,            -- 写入方
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, vol, section, key)
);

-- 写一个数（覆盖同键旧值）。
CREATE OR REPLACE FUNCTION progress.put_metric(
  p_book text, p_vol text, p_section text, p_key text, p_label text,
  p_value double precision, p_unit text, p_by text,
  p_value_text text DEFAULT NULL, p_detail jsonb DEFAULT NULL, p_sort integer DEFAULT 100
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(p_by, '') = '' THEN
    RAISE EXCEPTION 'by（写入方）必填';
  END IF;
  INSERT INTO progress.metric (book_id, vol, section, key, label, value, value_text, unit, detail, sort, writer, at)
  VALUES (coalesce(p_book, ''), coalesce(p_vol, ''), p_section, p_key, p_label, p_value, p_value_text, p_unit, p_detail,
          coalesce(p_sort, 100), p_by, now())
  ON CONFLICT (book_id, vol, section, key) DO UPDATE SET
    label = EXCLUDED.label, value = EXCLUDED.value, value_text = EXCLUDED.value_text, unit = EXCLUDED.unit,
    detail = EXCLUDED.detail, sort = EXCLUDED.sort, writer = EXCLUDED.writer, at = EXCLUDED.at;
END;
$$;

-- 先占好的栏目（用户 10-25：形近字、人审；异体字组当天并进形近字——同义、不同义的字组混合处理；口径由各领域自己定，改 description 即可）
INSERT INTO progress.section (section, title, owner, description, sort) VALUES
  ('xingjin', '形近字', 'A24', '形近与异体字组（同义、不同义）：各组出现、送审、送审率、核对准确率', 10),
  ('review', '人审', 'A32', '人审：人审率、已裁格数、网站意见处理等', 30)
ON CONFLICT (section) DO NOTHING;

INSERT INTO progress.meta (key, value) VALUES ('schema_version', '1') ON CONFLICT (key) DO NOTHING;
