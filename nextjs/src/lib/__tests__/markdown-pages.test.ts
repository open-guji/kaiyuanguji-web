/**
 * @jest-environment node
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { legacyMarkdownName, markdownPagePath, MARKDOWN_PAGE_NAMES } from '../markdown-pages';

describe('markdown-pages（overview#267：说明页挪到 /read/md/<名>）', () => {
    it('名单与 public/content 里的 .md 文件一致（新增说明页忘了更新名单会红）', () => {
        const files = readdirSync(join(process.cwd(), 'public/content'))
            .filter((f) => f.endsWith('.md'))
            .map((f) => f.replace(/\.md$/, ''))
            .sort();
        expect([...MARKDOWN_PAGE_NAMES].sort()).toEqual(files);
    });

    it('新地址', () => {
        expect(markdownPagePath('assistant')).toBe('/read/md/assistant');
    });

    it('旧地址里的名字：带不带 .md、URL 编码都认；别的一律 null', () => {
        expect(legacyMarkdownName('assistant')).toBe('assistant');
        expect(legacyMarkdownName('assistant.md')).toBe('assistant');
        expect(legacyMarkdownName('roadmap_overview.md')).toBe('roadmap_overview');
        expect(legacyMarkdownName('assist%61nt')).toBe('assistant');
        for (const v of ['d59f2htm01du', 'md', 'assistant.txt', '../assistant', '%E0%A4%A', '']) expect(legacyMarkdownName(v)).toBeNull();
    });
});
