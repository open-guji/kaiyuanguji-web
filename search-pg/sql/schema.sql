-- 书名搜索检索库（Postgres）：表与索引。迁移设计见 docs/search-pg-migration.md。
-- 约定：本文件在一个空 schema 里执行（schema 名由 psql 变量 :schema 给，默认 search_new，建完自检再改名成 search）。
-- 用法：psql -v ON_ERROR_STOP=1 -v schema=search_new -f schema.sql -f functions.sql
\if :{?schema}
\else
\set schema search_new
\endif
DROP SCHEMA IF EXISTS :"schema" CASCADE;
CREATE SCHEMA :"schema";
SET search_path = :"schema", public;

-- 一行 = 一条可搜索记录（works／books／collections／entities 同表，按 kind 分区）。
-- 词元列由入库程序算好（单字 + 相邻二字 + 拼音等，见 indexer/lib/pg-rows.mjs），库里不做分词。
CREATE TABLE search_doc (
  kind           text NOT NULL,          -- work | book | collection | entity
  id             text NOT NULL,
  title          text,                   -- 书名；人物为 primary_name
  author         text,
  dynasty        text,
  classification text,                   -- 部类；空＝未分類（存 NULL，查询时视为 ''）
  loss_status    text,
  subtype        text,
  has_text       boolean,
  has_image      boolean,
  has_collated   boolean,
  completeness   int,
  title_chars    int,
  era_rank       int,
  title_sort     text,
  office_ids     text[],                 -- 人物任官（entities 的 office_ids 筛选）
  title_tsv      tsvector,               -- 书名词元
  title_bkt      tsvector,               -- 书名词元前加字数桶，如 '05|書'：热门词按字数从短到长逐桶取
  name_tsv       tsvector,               -- 书名＋作者＋别名＋版本＋馆藏＋拼音
  desc_tsv       tsvector,               -- 简介＋著录摘要词元（works／books）
  descr          text,                   -- 简介原文前 1000 字（繁简并列），给高亮片段用
  payload        jsonb,                  -- 展示字段：edition、era、sort_year、role、juan_count、birth_year、death_year、cbdb_id、holder
  PRIMARY KEY (kind, id)
) PARTITION BY LIST (kind);
CREATE TABLE sd_work       PARTITION OF search_doc FOR VALUES IN ('work');
CREATE TABLE sd_book       PARTITION OF search_doc FOR VALUES IN ('book');
CREATE TABLE sd_entity     PARTITION OF search_doc FOR VALUES IN ('entity');
CREATE TABLE sd_collection PARTITION OF search_doc FOR VALUES IN ('collection');

-- 索引放在灌完数据之后建更快：schema.sql 只建表，索引见 indexes.sql（全量重建先灌后建；增量时索引已在）。

-- 元信息：当前对应哪一版目录库（rel）、表结构版本、各类行数
CREATE TABLE search_meta (
  k text PRIMARY KEY,
  v jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
