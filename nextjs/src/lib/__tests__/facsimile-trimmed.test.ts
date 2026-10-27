import { isFacsimileTrimmed } from '../facsimile-trimmed';

const img = (url: string) => [{ url, width: 1260, height: 1920 }] as never;

describe('isFacsimileTrimmed', () => {
    it('图地址带 qiefen2 段：已裁边', () => {
        expect(isFacsimileTrimmed(img('https://d/iiif/96mid1ogzk/11/qiefen2/0001/full/1200,/0/default.jpg'))).toBe(true);
    });
    it('老图源（无该段）、空、没有书影：不是', () => {
        expect(isFacsimileTrimmed(img('https://d/iiif/96mid1ogzk/11/0001/full/1200,/0/default.jpg'))).toBe(false);
        expect(isFacsimileTrimmed([])).toBe(false);
        expect(isFacsimileTrimmed(null)).toBe(false);
    });
});
