#!/usr/bin/env node
/**
 * npm run dev:latest —— 本地看「网站 dev + UI 包 dev 源码 + 最新数据」，不用发测试站。
 *
 *   - UI：BIM_UI_SRC 指向同级 ../book-index-manager/ui（改 UI 源码热更新）；
 *         找不到就报错并提示跑 scripts/local-latest.sh（它会替你浅克隆）。
 *         BIM_UI_SRC=npm 表示不用源码，用 node_modules 里装的那版。
 *   - 数据：NEXT_PUBLIC_DATA_SOURCE=cos，读 https://data.openguji.com（指针 latest.json，不要本地数据仓）。
 *   - 搜索：不配 L1 就走浏览器端 L2。
 *
 * 环境变量（都可选）：BIM_UI_SRC、NEXT_PUBLIC_COS_BASE、PORT、KYG_RENDER_MODE（默认 fullstack，设空＝静态导出那种）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ORIGIN } from '../../config/hosts.mjs';

const nextjs = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };

if (env.BIM_UI_SRC === 'npm') {
  delete env.BIM_UI_SRC;
} else {
  const ui = resolve(nextjs, env.BIM_UI_SRC || '../../book-index-manager/ui');
  if (!existsSync(join(ui, 'src', 'index.ts'))) {
    console.error(`找不到 UI 源码：${ui}\n先跑 bash scripts/local-latest.sh（会浅克隆 book-index-manager 到同级目录），或设 BIM_UI_SRC=<ui 目录>；只想用 npm 装的那版：BIM_UI_SRC=npm`);
    process.exit(1);
  }
  if (existsSync(join(ui, 'node_modules', 'react'))) {
    console.error(`⚠ ${ui}/node_modules 里装了 react：会造成两份 React（Hooks 报 null）。dev:latest 不需要在 ui/ 里装依赖，请删掉：rm -rf ${ui}/node_modules`);
    process.exit(1);
  }
  env.BIM_UI_SRC = ui;
}
env.NEXT_PUBLIC_MODE = '';
env.NEXT_PUBLIC_DATA_SOURCE = env.NEXT_PUBLIC_DATA_SOURCE || 'cos';
env.NEXT_PUBLIC_COS_BASE = env.NEXT_PUBLIC_COS_BASE || DATA_ORIGIN;
env.NEXT_PUBLIC_BASE_PATH = '';
// 与测试站一致：全栈渲染（/item/[id]、/read/[id] 等按请求渲染的页面才有）
env.KYG_RENDER_MODE = env.KYG_RENDER_MODE ?? 'fullstack';

const args = ['dev', '--webpack', ...(env.PORT ? ['-p', env.PORT] : [])];
console.log(`[dev:latest] UI=${env.BIM_UI_SRC ?? 'npm 包'}  数据=${env.NEXT_PUBLIC_COS_BASE}`);
const child = spawn(join(nextjs, 'node_modules', '.bin', 'next'), args, { cwd: nextjs, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
