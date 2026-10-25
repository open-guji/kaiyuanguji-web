-- 网站定时任务（.github/workflows/text-progress.yml）用的专用库账号 progress_sync 的权限。
-- 用户批准后，由有权限的人在 Neon 正式库执行（先 schema.sql，再本文件）；账号本身在 Neon 控制台建，口令不进仓。
-- 只能：读写 progress schema；只读 books、files、workspaces 三张表（基础采集要读册 yaml 与待审单）。别的表一概碰不到。
GRANT USAGE ON SCHEMA progress TO progress_sync;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA progress TO progress_sync;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA progress TO progress_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA progress GRANT SELECT, INSERT, UPDATE ON TABLES TO progress_sync;
GRANT SELECT ON public.workspaces, public.books, public.files TO progress_sync;
