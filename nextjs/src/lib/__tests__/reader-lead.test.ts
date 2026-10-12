/**
 * @jest-environment node
 *
 * overview#581：阅读页 description 取首章正文开头。
 */
import { describe, it, expect } from '@jest/globals';
import { leadText } from '../reader-lead';

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
