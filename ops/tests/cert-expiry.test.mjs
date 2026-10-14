/**
 * ops/cert-expiry.mjs 单测（不联网，只测纯函数）。
 *
 * 跑法（仓库根目录）：node --test ops/tests/cert-expiry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft, issuerLabel, looksPublicCa, evaluate, exitCodeFor, parseArgs, DEFAULT_HOSTS, DEFAULT_MIN_DAYS } from '../cert-expiry.mjs';

const NOW = new Date('2026-10-14T12:00:00Z');
const at = (days) => new Date(NOW.getTime() + days * 86_400_000);
const LE = { O: "Let's Encrypt", CN: 'R11' };
const cert = (days, extra = {}) => ({ validFrom: at(-60), validTo: at(days), issuer: LE, subjectCN: 'x', selfSigned: false, ...extra });

test('daysLeft：向下取整，过期为负', () => {
    assert.equal(daysLeft(at(30), NOW), 30);
    assert.equal(daysLeft(new Date(NOW.getTime() + 20.9 * 86_400_000), NOW), 20);
    assert.equal(daysLeft(at(-1), NOW), -1);
});

test('evaluate：阈值边界（30 天过，29 天报）', () => {
    assert.equal(evaluate('a', cert(30), null, 30, NOW).status, 'ok');
    assert.equal(evaluate('a', cert(29), null, 30, NOW).status, 'expiring');
    assert.equal(evaluate('a', cert(0), null, 30, NOW).status, 'expiring');
    assert.equal(evaluate('a', cert(-1), null, 30, NOW).status, 'expired');
});

test('evaluate：握手失败或没证书 → error', () => {
    assert.equal(evaluate('a', null, new Error('ENOTFOUND'), 30, NOW).status, 'error');
    assert.equal(evaluate('a', null, null, 30, NOW).status, 'error');
});

test('evaluate：自签名或非公共 CA 标疑似中转，公共 CA 不标', () => {
    assert.equal(evaluate('a', cert(90), null, 30, NOW).suspectedIntercept, false);
    assert.equal(evaluate('a', cert(90, { issuer: { O: 'Some Egress Gateway', CN: 'gw-ca' } }), null, 30, NOW).suspectedIntercept, true);
    assert.equal(evaluate('a', cert(90, { selfSigned: true }), null, 30, NOW).suspectedIntercept, true);
});

test('issuerLabel／looksPublicCa', () => {
    assert.equal(issuerLabel(LE), "Let's Encrypt / R11");
    assert.equal(issuerLabel(null), '');
    assert.equal(looksPublicCa(null), null);
    assert.equal(looksPublicCa({ O: 'DigiCert Inc' }), true);
});

test('exitCodeFor：到期/过期=1 优先于 error=3；全过=0', () => {
    const ok = { status: 'ok' };
    assert.equal(exitCodeFor([ok, ok]), 0);
    assert.equal(exitCodeFor([ok, { status: 'error' }]), 3);
    assert.equal(exitCodeFor([ok, { status: 'expiring' }, { status: 'error' }]), 1);
    assert.equal(exitCodeFor([{ status: 'expired' }]), 1);
});

test('parseArgs：默认清单与阈值；--days／--json／指定域名；非法参数', () => {
    assert.deepEqual(parseArgs([]), { hosts: DEFAULT_HOSTS, days: DEFAULT_MIN_DAYS, json: false });
    assert.deepEqual(parseArgs(['--days', '30', '--json', 'a.com']), { hosts: ['a.com'], days: 30, json: true });
    assert.ok(parseArgs(['--days', 'x']).error);
    assert.ok(parseArgs(['--nope']).error);
});
