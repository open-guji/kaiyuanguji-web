// 把 Better Auth 的表建到 D1：CF_D1_DATABASE_ID=… npx tsx scripts/ba-d1-migrate.mts（令牌取环境变量，不进仓）
import { getMigrations } from 'better-auth/db/migration';
import { auth } from '../src/lib/server/ba-auth.ssr';
const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(auth.options);
console.log('create', toBeCreated.map((t:any)=>t.table), 'add', toBeAdded.length);
await runMigrations(); console.log('migrated');
