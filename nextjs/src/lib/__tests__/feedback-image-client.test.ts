import { dataUrlBytes, fitSize } from '../feedbackImage';
import { buildFeedbackBody } from '../feedback';

describe('feedbackImage', () => {
    it('fitSize 只缩不放，最长边 ≤1600', () => {
        expect(fitSize(3200, 1600)).toEqual({ w: 1600, h: 800 });
        expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
    });
    it('dataUrlBytes 按 base64 长度算解码字节', () => {
        expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
        expect(dataUrlBytes('data:image/jpeg;base64,AA==')).toBe(1);
    });
    it('buildFeedbackBody 带图且最多 3 张', () => {
        const b = buildFeedbackBody({ type: 'bug', text: 'x', pageUrl: 'https://a/b', images: ['a', 'b', 'c', 'd'] });
        expect(b.images).toEqual(['a', 'b', 'c']);
        expect(buildFeedbackBody({ type: 'bug', text: 'x', pageUrl: 'https://a/b' }).images).toBeUndefined();
    });
});
