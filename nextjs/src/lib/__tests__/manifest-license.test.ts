import { normalizeManifestLicense } from '../manifest-license';

describe('normalizeManifestLicense', () => {
    it('本站自做版本的 CC0 改成 CC BY-SA 4.0，source.license 同改', () => {
        const m = normalizeManifestLicense({
            versions: [{ key: 'default', kind: 'self_collated', source: 'original', license: 'CC0 1.0' }],
            source: { name: '開源古籍CV整理（武英殿刻本）', license: 'CC0 1.0' },
        });
        expect(m.versions[0].license).toBe('CC BY-SA 4.0');
        expect(m.source.license).toBe('CC BY-SA 4.0');
    });
    it('别家来源的授权原样保留', () => {
        const m = normalizeManifestLicense({
            versions: [{ key: 'wikisource', source: 'wikisource', license: 'CC0 1.0' }, { key: 'k', source: 'kanripo', license: 'CC BY-SA' }],
            source: { name: '某上游', license: 'CC0' },
        });
        expect(m.versions[0].license).toBe('CC0 1.0');
        expect(m.versions[1].license).toBe('CC BY-SA');
        expect(m.source.license).toBe('CC0');
    });
    it('空值与非对象不报错', () => {
        expect(normalizeManifestLicense(null)).toBeNull();
        expect(normalizeManifestLicense({ versions: [null, { source: 'original' }] })).toBeTruthy();
    });
});
