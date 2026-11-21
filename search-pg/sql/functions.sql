-- 查询函数。psql -v schema=search_new -f functions.sql（与 schema.sql 同一个 schema）
\if :{?schema}
\else
\set schema search_new
\endif
SET search_path = :"schema", public;

-- 查询串 → tsquery：中文段 1 字取单字，≥2 字取全部相邻二字（AND）；拉丁词／拼音取前缀（:*）。
-- pfx 非空时给每个词元加前缀（书名字数桶，如 '05|'）。无可用词元返回 NULL。
CREATE OR REPLACE FUNCTION q2tsq(q text, pfx text DEFAULT '') RETURNS tsquery LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parts text[] := '{}'; m text; i int;
BEGIN
  FOR m IN SELECT (regexp_matches(lower(q), '[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0003ffff]+|[0-9a-z]+', 'g'))[1] LOOP
    IF m ~ '^[0-9a-z]+$' THEN parts := parts || (quote_literal(pfx || m) || ':*');
    ELSIF char_length(m) = 1 THEN parts := parts || quote_literal(pfx || m);
    ELSE FOR i IN 1 .. char_length(m) - 1 LOOP parts := parts || quote_literal(pfx || substr(m, i, 2)); END LOOP;
    END IF;
  END LOOP;
  IF cardinality(parts) = 0 THEN RETURN NULL; END IF;
  RETURN array_to_string(parts, ' & ')::tsquery;
END $$;

-- 查询串 → 「书名以它开头」的 tsquery：取查询里第一段中文的前 2 字（1 字查询取 1 字），对应入库时的 '^' 开头词元；拉丁／拼音查询返回 NULL（不分先后）
CREATE OR REPLACE FUNCTION q2head(q text) RETURNS tsquery LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE m text;
BEGIN
  m := (regexp_match(lower(q), '[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0003ffff]+'))[1];
  IF m IS NULL THEN RETURN NULL; END IF;
  RETURN quote_literal('^' || left(m, 2))::tsquery;
END $$;

-- 一行 → 对外 hit（字段同 Meili 返回的卡片字段）；with_descr=true 时带简介原文（search-api 据此裁片段、加高亮）
CREATE OR REPLACE FUNCTION hit_json(d search_doc, with_descr bool) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', d.id, 'type', d.kind, 'is_draft', false, 'title', d.title,
           'author', d.author, 'dynasty', d.dynasty, 'classification', coalesce(d.classification, ''),
           'loss_status', d.loss_status, 'subtype', d.subtype,
           'has_text', d.has_text, 'has_image', d.has_image, 'has_collated', d.has_collated,
           '_descr', CASE WHEN with_descr THEN d.descr END) || coalesce(d.payload, '{}'))
$$;

-- 一个索引的一次搜索，对应 Meili 的 rankingRules（attribute → title_chars↑ → completeness↓）：
--   段 1 书名命中、段 2 其他名称字段（作者／别名／版本／馆藏／拼音）命中、段 3 只有简介命中（works／books）。
--   每段先数（封顶 1001），需要时才取页；total 封顶 1000（Meili 的 estimatedTotalHits 也只到 maxTotalHits）。
--   热门词（书名段 >1000 条）且按相关度排时，书名段按字数桶从短到长逐桶取，每桶是小集合，结果与全排一致。
-- 筛选参数：数组＝取值之一（空串表示「该字段为空」）；NULL＝不筛。p_sort ∈ era:asc|desc、title:asc|desc 或 NULL。
CREATE OR REPLACE FUNCTION search_one(p_kind text, p_q text, p_limit int DEFAULT 20, p_offset int DEFAULT 0,
  p_dynasty text[] DEFAULT NULL, p_class text[] DEFAULT NULL, p_loss text[] DEFAULT NULL,
  p_has_text bool DEFAULT NULL, p_has_image bool DEFAULT NULL, p_has_collated bool DEFAULT NULL,
  p_office text DEFAULT NULL, p_sort text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE tq tsquery := q2tsq(p_q); hq tsquery := q2head(p_q); ph int; need int := p_offset + p_limit;
        got int := 0; n int; b int; btq tsquery; acc jsonb := '[]'; part jsonb;
BEGIN
  IF tq IS NULL THEN RETURN jsonb_build_object('hits', '[]'::jsonb, 'estimatedTotalHits', 0); END IF;

  -- 段 1：书名
  SELECT count(*) INTO n FROM (SELECT 1 FROM search_doc d WHERE d.kind = p_kind AND d.title_tsv @@ tq
      AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office]) LIMIT 1001) x;
  IF n > 1000 AND p_sort IS NULL THEN
    -- 先取「书名以查询词开头」的（ph=0），再取其余（ph=1）；每一轮内部按字数桶从短到长
    FOR ph IN 0..1 LOOP
    CONTINUE WHEN ph = 0 AND hq IS NULL;
    b := 1;
    WHILE jsonb_array_length(acc) < need AND b <= 40 LOOP
      btq := q2tsq(p_q, lpad(b::text, 2, '0') || '|');
      SELECT coalesce(jsonb_agg(hit_json(d.r, false) ORDER BY d.rn), '[]') INTO part FROM (
        SELECT d AS r, row_number() OVER (ORDER BY d.completeness DESC, d.id) rn FROM search_doc d
        WHERE d.kind = p_kind AND d.title_bkt @@ btq
          AND (hq IS NULL OR (d.title_tsv @@ hq) = (ph = 0))
          AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office])
        ORDER BY d.completeness DESC, d.id LIMIT need - jsonb_array_length(acc)) d;
      acc := acc || part; b := b + 1;
    END LOOP;
    END LOOP;
  ELSIF n > 0 THEN
    SELECT coalesce(jsonb_agg(hit_json(d.r, false) ORDER BY d.rn), '[]') INTO acc FROM (
      SELECT d AS r, row_number() OVER (ORDER BY
               CASE WHEN p_sort = 'era:asc' THEN d.era_rank END ASC, CASE WHEN p_sort = 'era:desc' THEN d.era_rank END DESC,
               CASE WHEN p_sort = 'title:asc' THEN d.title_sort END ASC, CASE WHEN p_sort = 'title:desc' THEN d.title_sort END DESC,
               CASE WHEN d.title_tsv @@ hq THEN 0 ELSE 1 END, d.title_chars, d.completeness DESC, d.id) rn
      FROM search_doc d WHERE d.kind = p_kind AND d.title_tsv @@ tq
        AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office])
      ORDER BY rn LIMIT need) d;
  END IF;
  got := n;

  -- 段 2：其他名称字段
  IF got < 1001 THEN
    SELECT count(*) INTO n FROM (SELECT 1 FROM search_doc d WHERE d.kind = p_kind AND d.name_tsv @@ tq AND NOT d.title_tsv @@ tq
        AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office]) LIMIT 1001 - got) x;
    IF n > 0 AND got < need THEN
      SELECT coalesce(jsonb_agg(hit_json(d.r, false) ORDER BY d.rn), '[]') INTO part FROM (
        SELECT d AS r, row_number() OVER (ORDER BY
                 CASE WHEN p_sort = 'era:asc' THEN d.era_rank END ASC, CASE WHEN p_sort = 'era:desc' THEN d.era_rank END DESC,
               CASE WHEN p_sort = 'title:asc' THEN d.title_sort END ASC, CASE WHEN p_sort = 'title:desc' THEN d.title_sort END DESC,
               d.title_chars + 0, d.completeness DESC, d.id) rn
        FROM search_doc d WHERE d.kind = p_kind AND d.name_tsv @@ tq AND NOT d.title_tsv @@ tq
          AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office])
        ORDER BY rn LIMIT need - got) d;
      acc := acc || part;
    END IF;
    got := got + n;
  END IF;

  -- 段 3：只有简介命中（works／books）；段内超过 1000 条时不排序，按存储顺序取
  IF got < 1001 AND p_kind IN ('work', 'book') AND p_office IS NULL THEN
    SELECT count(*) INTO n FROM (SELECT 1 FROM search_doc d WHERE d.kind = p_kind AND d.desc_tsv @@ tq AND NOT d.name_tsv @@ tq
        AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office]) LIMIT 1001 - got) x;
    IF n > 0 AND got < need THEN
      SELECT coalesce(jsonb_agg(hit_json(d.r, true) ORDER BY d.rn), '[]') INTO part FROM (
        SELECT d AS r, row_number() OVER (ORDER BY
                 CASE WHEN p_sort = 'era:asc' THEN d.era_rank END ASC, CASE WHEN p_sort = 'era:desc' THEN d.era_rank END DESC,
                 CASE WHEN p_sort = 'title:asc' THEN d.title_sort END ASC, CASE WHEN p_sort = 'title:desc' THEN d.title_sort END DESC,
                 CASE WHEN n + got <= 1000 THEN d.title_chars END, CASE WHEN n + got <= 1000 THEN d.completeness END DESC) rn
        FROM search_doc d WHERE d.kind = p_kind AND d.desc_tsv @@ tq AND NOT d.name_tsv @@ tq
          AND (p_dynasty IS NULL OR d.dynasty = ANY (p_dynasty))
        AND (p_class IS NULL OR coalesce(d.classification, '') = ANY (p_class))
        AND (p_loss IS NULL OR coalesce(d.loss_status, '') = ANY (p_loss))
        AND (p_has_text IS NULL OR d.has_text = p_has_text) AND (p_has_image IS NULL OR d.has_image = p_has_image)
        AND (p_has_collated IS NULL OR d.has_collated = p_has_collated)
        AND (p_office IS NULL OR d.office_ids @> ARRAY[p_office])
        ORDER BY rn LIMIT need - got) d;
      acc := acc || part;
    END IF;
    got := got + n;
  END IF;

  SELECT coalesce(jsonb_agg(e ORDER BY i), '[]') INTO part
    FROM jsonb_array_elements(acc) WITH ORDINALITY t(e, i) WHERE i > p_offset AND i <= need;
  RETURN jsonb_build_object('hits', part, 'estimatedTotalHits', least(got, 1000));
END $$;
ALTER FUNCTION search_one(text,text,int,int,text[],text[],text[],bool,bool,bool,text,text) SET plan_cache_mode = force_custom_plan;
