import { gunzipSync } from 'node:zlib';
import { gzipText } from '../gzip-body';

describe('gzipText', () => {
    it('压出来的字节解开与原文一致，且重复的 sitemap 文本明显变小', () => {
        const xml = '<?xml version="1.0"?><urlset>' + '<url><loc>https://www.kaiyuanguji.com/item/d59df01avcw0</loc></url>'.repeat(2000) + '</urlset>';
        const gz = gzipText(xml);
        expect(gunzipSync(gz).toString('utf-8')).toBe(xml);
        expect(gz.length).toBeLessThan(xml.length / 5);
    });
});
