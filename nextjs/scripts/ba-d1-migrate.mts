// 把 Better Auth 的表建到认证库 openguji-auth（经 Worker 网关）：BA_AUTH_URL=… BA_AUTH_TOKEN=… BETTER_AUTH_URL=… npx tsx scripts/ba-d1-migrate.mts（令牌取环境变量，不进仓）
import { getMigrations } from 'better-auth/db/migration';
import { getAuth } from "../src/lib/server/ba-auth.ssr";
const auth = getAuth();
const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(auth.options);
console.log('create', toBeCreated.map((t:any)=>t.table), 'add', toBeAdded.length);
await runMigrations(); console.log('migrated');
