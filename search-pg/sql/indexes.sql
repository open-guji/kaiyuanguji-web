-- 灌完数据后建索引（全量重建用）。psql -v schema=search_new -f indexes.sql
\if :{?schema}
\else
\set schema search_new
\endif
SET search_path = :"schema", public;
SET maintenance_work_mem = '512MB';
CREATE INDEX sd_title_gin     ON search_doc USING gin (title_tsv);
CREATE INDEX sd_title_bkt_gin ON search_doc USING gin (title_bkt);
CREATE INDEX sd_name_gin      ON search_doc USING gin (name_tsv);
CREATE INDEX sd_desc_gin      ON search_doc USING gin (desc_tsv);
CREATE INDEX sd_office_gin    ON search_doc USING gin (office_ids);
CREATE INDEX sd_rank          ON search_doc (title_chars, completeness DESC, id);
ANALYZE search_doc;
