-- 上海搜索机：账号与权限（Deploy 用超级用户跑一次；密码从 guji-dev-secret 取，不写进仓库）
--   psql -v ing_pw="'…'" -v ro_pw="'…'" -d guji -f roles.sql
-- search_ingest：搜索入库（建／换 schema、写 search_doc）；search_ro：search-api 只读。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'search_ingest') THEN CREATE ROLE search_ingest LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'search_ro') THEN CREATE ROLE search_ro LOGIN; END IF;
END $$;
ALTER ROLE search_ingest PASSWORD :ing_pw;
ALTER ROLE search_ro PASSWORD :ro_pw;
GRANT CREATE ON DATABASE guji TO search_ingest;
-- schema 由 search_ingest 创建（schema.sql 的 search_new → 换名 search），只读账号在每次换名后由 ingest 补授权：
ALTER DEFAULT PRIVILEGES FOR ROLE search_ingest IN SCHEMA public GRANT SELECT ON TABLES TO search_ro;
ALTER ROLE search_ro SET statement_timeout = '2s';
ALTER ROLE search_ro SET plan_cache_mode = 'force_custom_plan';
-- 授权语句（ingest 每次建完 schema 后执行）：
--   GRANT USAGE ON SCHEMA search TO search_ro; GRANT SELECT ON ALL TABLES IN SCHEMA search TO search_ro;
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA search TO search_ro;
