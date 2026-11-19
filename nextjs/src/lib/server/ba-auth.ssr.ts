// 试验：Better Auth 在 EdgeOne Node 函数（Next standalone）里能否跑。不进正式站。
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { Pool } from 'pg';

export const auth = betterAuth({
  basePath: '/api/ba',
  secret: process.env.BETTER_AUTH_SECRET || 'experiment-only-secret-change-me-0123456789',
  database: new Pool({ connectionString: process.env.BA_DATABASE_URL }),
  session: { expiresIn: 60 * 60 * 24 * 180, updateAge: 60 * 60 * 24 },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        console.log('[ba-experiment] magic link for', email, url); // 试验：只打日志，不发信
      },
    }),
  ],
});
