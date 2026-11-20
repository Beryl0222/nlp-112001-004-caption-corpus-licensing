import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkspace } from '../src/index.js';
import { evaluateOrder, expressSameFact } from '../src/assessment.js';

const workspace = await loadWorkspace();
const { orders, proposals, shotIndex, parsedLicenses } = workspace;
const orderById = Object.fromEntries(orders.map((o) => [o.id, o]));

function decide(orderId, date) {
  const report = evaluateOrder({
    order: orderById[orderId], proposals, shotIndex, parsedLicenses, date
  });
  return Object.fromEntries(report.decisions.map((d) => [d.proposalId, d]));
}

test('o1 国内教育中文：d1 必须更正（事实无据+逐字招牌），d3 经 f3 替代可交付', () => {
  const result = decide('o1', '2026-09-04');
  assert.equal(result.d1.decision, 'needsCorrection');
  assert.ok(result.d1.restrictionViolations.length > 0);
  assert.equal(result.d3.decision, 'deliverableWithAlternative');
  assert.deepEqual(result.d3.validBasis, ['f3']);
  assert.ok(result.d3.alternatives.some((a) => a.shotId === 'f3' && a.coverage.status === 'granted'));
});

test('o2 英文教育：撤回生效后 d2 无英文授权且替代 f2 已撤回，必须更正不得自动替换', () => {
  // l4 于 2026-09-10 撤回英文教育许可，故在其生效后评估。
  const result = decide('o2', '2026-09-11');
  assert.equal(result.d2.decision, 'needsCorrection');
  assert.ok(result.d2.alternatives.some((a) => a.coverage.status === 'withdrawn'));
});

test('撤回生效前（l4 签发日之前）原英文授权仍然有效', () => {
  const result = decide('o2', '2026-09-08');
  assert.equal(result.d2.decision, 'deliverableWithAlternative');
});

test('o3 国内广告中文：l3 覆盖广告，d3 可经 f3 交付；d1 无广告授权须更正', () => {
  const result = decide('o3', '2026-09-12');
  assert.equal(result.d3.decision, 'deliverableWithAlternative');
  assert.equal(result.d1.decision, 'needsCorrection');
  assert.ok(result.d1.blockedBasis.every((b) => b.status === 'noGrant'));
});

test('许可期限到期后替代授权失效，d3 转为必须更正', () => {
  const result = decide('o3', '2027-04-01');
  assert.equal(result.d3.decision, 'needsCorrection');
});

test('每条决定都给出可审核的中文理由与依据来源', () => {
  const result = decide('o1', '2026-09-04');
  for (const decision of Object.values(result)) {
    assert.ok(Array.isArray(decision.reasons) && decision.reasons.length > 0);
    assert.ok(decision.coverage);
  }
});

test('要求中英对照时，许可只覆盖一端则不得标为双语对照', () => {
  const parallelOrder = {
    ...orderById.o2, parallel: true, language: 'zh'
  };
  const report = evaluateOrder({
    order: parallelOrder, proposals, shotIndex, parsedLicenses, date: '2026-09-12'
  });
  const pair = report.parallelReport.pairs.find((p) => p.zh === 'd3' && p.en === 'd2');
  assert.ok(pair);
  assert.equal(pair.parallelLabelAllowed, false);
  assert.equal(expressSameFact(proposals.find((p) => p.id === 'd2'), proposals.find((p) => p.id === 'd3')), true);
});

test('失去授权的依据被拦截，替代来源独立承接事实，不影响其余可交付内容', () => {
  // l4 只撤回英文教育许可；o1 为中文查询，f2 本就无中文授权，状态为 noGrant。
  const result = decide('o1', '2026-09-11');
  const blocked = result.d3.blockedBasis.find((b) => b.source === 'f2');
  assert.ok(blocked);
  assert.equal(blocked.needed, true);
  assert.equal(blocked.status, 'noGrant');
  assert.deepEqual(result.d3.validBasis, ['f3']);
});

test('英文查询下 f2 在 l4 生效后明确为 withdrawn', () => {
  const result = decide('o2', '2026-09-11');
  const f2 = result.d2.blockedBasis.find((b) => b.source === 'f3');
  // d2 的直接依据是 f3（无英文授权）；f2 作为替代来源时被撤回。
  assert.ok(result.d2.alternatives.some((a) => a.shotId === 'f2' && a.coverage.status === 'withdrawn'));
  assert.ok(f2);
});
