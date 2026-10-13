/**
 * @jest-environment node
 *
 * overview#581：阅读页 description 取首章正文开头。
 */
import { describe, it, expect } from '@jest/globals';
import { leadParagraphs, leadText } from '../reader-lead';

describe('leadText', () => {
    it('去标题行、强调、链接与校勘括号，折叠空白', () => {
        const md = '# 卷一\n\n## 小节\n\n**景鸞易説**\n\n范書儒林傳：景鸞，字漢伯\\(一作漢柏\\)，[廣漢](x)梓潼人也。\n\n少隨師學經。';
        expect(leadText(md, 200)).toBe('景鸞易説 范書儒林傳：景鸞，字漢伯，廣漢梓潼人也。 少隨師學經。');
    });
    it('超长按码位截断并加省略号，不劈开扩展区汉字', () => {
        expect(leadText('𠮷'.repeat(10), 4)).toBe('𠮷𠮷𠮷𠮷…');
        expect(leadText('一二三四五', 5)).toBe('一二三四五');
    });
    it('无正文返回空串（调用方回落模板句）', () => {
        expect(leadText(null)).toBe('');
        expect(leadText('')).toBe('');
        expect(leadText('# 只有标题\n')).toBe('');
    });
});

describe('leadParagraphs（服务端直出首章正文，overview#581）', () => {
    it('空输入返回空', () => {
        expect(leadParagraphs(null)).toEqual({ paragraphs: [], truncated: false });
        expect(leadParagraphs('')).toEqual({ paragraphs: [], truncated: false });
    });
    it('按段落切，去标题行、图片与标签，保留校勘括号', () => {
        const r = leadParagraphs('# 卷一\n\n天地玄黄\\(一作元\\)。\n宇宙洪荒。\n\n![图](a.png)\n\n<br>日月盈昃');
        expect(r.paragraphs).toEqual(['天地玄黄\\(一作元\\)。 宇宙洪荒。', '日月盈昃']);
        expect(r.truncated).toBe(false);
    });
    it('超过上限在段落边界停，标记 truncated', () => {
        const r = leadParagraphs('甲'.repeat(60) + '\n\n' + '乙'.repeat(60) + '\n\n' + '丙'.repeat(60), 130);
        expect(r.paragraphs).toEqual(['甲'.repeat(60), '乙'.repeat(60)]);
        expect(r.truncated).toBe(true);
    });
    it('第一段就超长：按码位截断，不劈开扩展区汉字', () => {
        const r = leadParagraphs('𠀀'.repeat(50), 10);
        expect(r.paragraphs).toEqual(['𠀀'.repeat(10) + '…']);
        expect(r.truncated).toBe(true);
    });
});
