/**
 * 由 out/shots/manifest.json 生成 shots 分支目录里的 README.md（markdown 表格，图用相对路径，GitHub 上直接能看）。
 * 用法：node readme.mjs <shots 目录> <标题>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, title = '截图'] = process.argv.slice(2);
const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
const img = (c, w) => (!c ? '' : c.ok ? `<img src="${c.name}" width="${w}">` : `❌ ${c.error}`);
const cmp = !!m.compare;
const head = cmp
    ? '| 页面 | 桌面 1440 | 对照 1440 | 手机 390 | 对照 390 |\n|---|---|---|---|---|'
    : '| 页面 | 桌面 1440 | 手机 390 |\n|---|---|---|';
const rows = m.rows.map(({ p, cells }) => {
    const name = `**${p.title}**<br>\`${p.path}\``;
    return cmp
        ? `| ${name} | ${img(cells['1440'], 420)} | ${img(cells['1440-cmp'], 420)} | ${img(cells['390'], 150)} | ${img(cells['390-cmp'], 150)} |`
        : `| ${name} | ${img(cells['1440'], 640)} | ${img(cells['390'], 200)} |`;
});
const md = `# ${title}\n\n目标：${m.target}${cmp ? `  ·  对照：${m.compare}` : ''}\n\n${head}\n${rows.join('\n')}\n`;
await writeFile(join(dir, 'README.md'), md);
