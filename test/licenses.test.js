import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLicense, parseLicenses } from '../src/licenses.js';

test('l1 解析出地区、用途、期限与逐字禁止，且无 unresolved', () => {
  const parsed = parseLicense({
    id: 'l1', source: 'f1', issuedOn: '2026-09-01', licensor: '浪阶',
    text: '准予国内教学集使用动作概述，不能逐字保留招牌。条款截至十二月底。'
  });
  assert.equal(parsed.grants.length, 1);
  const grant = parsed.grants[0];
  assert.equal(grant.region, '国内');
  assert.deepEqual(grant.useFamilies, ['教学']);
  assert.deepEqual(grant.languages, []);
  assert.equal(grant.period.validUntil, '2026-12-31');
  assert.equal(parsed.unresolved.length, 0);
  assert.ok(parsed.restrictions.some((r) => r.type === 'verbatimForbidden'));
});

test('l2 明确翻译授权且标记非商用限制', () => {
  const parsed = parseLicense({
    id: 'l2', source: 'f2', issuedOn: '2026-09-01', licensor: '浪阶',
    text: '描述可译作英文并交给教育研究团队。仅限非商用。'
  });
  const grant = parsed.grants[0];
  assert.deepEqual(grant.languages, ['en']);
  assert.equal(grant.translationAllowed, true);
  assert.ok(parsed.restrictions.some((r) => r.type === 'nonCommercialOnly'));
});

test('l3 “明年三月前”按该月最后一日解析', () => {
  const parsed = parseLicense({
    id: 'l3', source: 'f3', issuedOn: '2026-09-03', licensor: '岸信',
    text: '明年三月前可给国内教育和广告合作方提供动作概述。'
  });
  assert.equal(parsed.grants[0].period.validUntil, '2027-03-31');
  assert.deepEqual(parsed.grants[0].useFamilies, ['教学', '广告']);
});

test('l4 撤回与“可继续讨论”分段归类，撤回只覆盖英文', () => {
  const parsed = parseLicense({
    id: 'l4', source: 'f2', issuedOn: '2026-09-10', licensor: '浪阶',
    text: '撤回面向教育合作方的英文语料许可，中文概述可继续讨论。'
  });
  assert.equal(parsed.withdrawals.length, 1);
  assert.deepEqual(parsed.withdrawals[0].languages, ['en']);
  assert.equal(parsed.grants.length, 0);
  assert.equal(parsed.unresolved.length, 1);
  assert.ok(parsed.unresolved[0].clause.includes('可继续讨论'));
});

test('每个结构化结论都带原句与 span，可回溯到许可原文', () => {
  const [parsed] = parseLicenses([
    { id: 'l1', source: 'f1', issuedOn: '2026-09-01', licensor: 'x',
      text: '准予国内教学集使用动作概述，不能逐字保留招牌。条款截至十二月底。' }
  ]);
  for (const grant of parsed.grants) {
    assert.ok(grant.span && typeof grant.span.start === 'number');
    assert.ok(parsed.raw.includes(grant.clause));
  }
});
