#!/bin/sh
# 从上海机 PG 抽样生成对比查询：整书名、前 2 字、单字、作者、书目条目、人物、丛书。
# 用法：PGPASSWORD=… sh make-queries.sh > q.tsv    （PGHOST/PGUSER/PGDATABASE 默认 127.0.0.1/search_ro/guji）
psql -X -At -F '	' -h "${PGHOST:-127.0.0.1}" -U "${PGUSER:-search_ro}" "${PGDATABASE:-guji}" <<'SQL'
SET search_path=search,public;
SET statement_timeout=0;  -- random() 排序会全表扫，search_ro 默认 2 秒会超时
SELECT 'works', title FROM search_doc WHERE kind='work' AND title<>'' ORDER BY random() LIMIT 700;
SELECT 'works', left(title,2) FROM search_doc WHERE kind='work' AND char_length(title)>=3 ORDER BY random() LIMIT 400;
SELECT 'works', left(title,1) FROM search_doc WHERE kind='work' AND title<>'' ORDER BY random() LIMIT 60;
SELECT 'works', author FROM search_doc WHERE kind='work' AND author<>'' ORDER BY random() LIMIT 300;
SELECT 'books', title FROM search_doc WHERE kind='book' AND title<>'' ORDER BY random() LIMIT 250;
SELECT 'entities', title FROM search_doc WHERE kind='entity' AND title<>'' ORDER BY random() LIMIT 250;
SELECT 'collections', title FROM search_doc WHERE kind='collection' AND title<>'' ORDER BY random() LIMIT 100;
SQL
