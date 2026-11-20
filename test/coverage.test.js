import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLicenses } from '../src/licenses.js';
import { checkCoverage } from '../src/coverage.js';

const licenses = parseLicenses([
  { id: 'l1', source: 'f1', issuedOn: '2026-09-01', licensor: '浪阶',
    text: '准予国内教学集使用动作概述，不能逐字保留招牌。条款截至十二月底。' },
  { id: 'l2', source: 'f2', issuedOn: '2026-09-01', licensor: '浪阶',
    text: '描述可译作英文并交给教育研究团队。仅限非商用。' },
  { id: 'l3', source: 'f3', issuedOn: '2026-09-03', licensor: '岸信',
    text: '明年三月前可给国内教育和广告合作方提供动作概述。' },
  { id: 'l4', source: 'f2', issuedOn: '2026-09-10', licensor: '浪阶',
    text: '撤回面向教育合作方的英文语料许可，中文概述可继续讨论。' }
]);

test('l1 在期限内覆盖国内教育中文，过期后变为 noGrant', () => {
  const query = { region: '国内', use: '教育', language: 'zh', date: '2026-11-20' };
  assert.equal(checkCoverage(licenses, 'f1', 'zh', query).status, 'granted');
  assert.equal(
    checkCoverage(licenses, 'f1', 'zh', { ...query, date: '2027-01-01' }).status,
    'noGrant'
  );
});

test('l2 英文翻译授权被 l4 在撤回日期后覆盖为 withdrawn', () => {
  const query = { region: '国内', use: '教育', language: 'en', date: '2026-09-08' };
  assert.equal(checkCoverage(licenses, 'f2', 'zh', query).status, 'granted');
  assert.equal(
    checkCoverage(licenses, 'f2', 'zh', { ...query, date: '2026-09-11' }).status,
    'withdrawn'
  );
});

test('l4 的中文讨论措辞不影响英文撤回判断本身', () => {
  const result = checkCoverage(licenses, 'f2', 'zh',
    { region: '国内', use: '教育', language: 'en', date: '2026-09-11' });
  assert.equal(result.status, 'withdrawn');
  assert.ok(result.withdrawals.some((w) => w.licenseId === 'l4'));
});

test('l3 同时覆盖教育与广告，英文因未获翻译授权而 noGrant', () => {
  const zh = { region: '国内', use: '广告', language: 'zh', date: '2026-11-20' };
  assert.equal(checkCoverage(licenses, 'f3', 'zh', zh).status, 'granted');
  const en = { region: '国内', use: '教育', language: 'en', date: '2026-11-20' };
  assert.equal(checkCoverage(licenses, 'f3', 'zh', en).status, 'noGrant');
});

test('许可地区范围无法确定时降级为 review，绝不自动放行', () => {
  const parsed = parseLicenses([
    { id: 'lx', source: 'f3', issuedOn: '2026-09-01', licensor: '岸信',
      text: '明年三月前可给部分地区的教育和广告合作方提供动作概述。' }
  ]);
  const result = checkCoverage(parsed, 'f3', 'zh',
    { region: '国内', use: '教育', language: 'zh', date: '2026-11-20' });
  assert.equal(result.status, 'review');
  assert.ok(result.reviewReasons.length > 0);
});

test('许可未写地区视为不限地区，正常授权不降级 review', () => {
  const parsed = parseLicenses([
    { id: 'lx', source: 'f3', issuedOn: '2026-09-01', licensor: '岸信',
      text: '明年三月前可给教育和广告合作方提供动作概述。' }
  ]);
  const result = checkCoverage(parsed, 'f3', 'zh',
    { region: '国内', use: '教育', language: 'zh', date: '2026-11-20' });
  assert.equal(result.status, 'granted');
});

test('结论回附命中的许可条款与原文 span', () => {
  const result = checkCoverage(licenses, 'f3', 'zh',
    { region: '国内', use: '广告', language: 'zh', date: '2026-11-20' });
  assert.equal(result.grants[0].licenseId, 'l3');
  assert.ok(result.grants[0].span.end > result.grants[0].span.start);
});
