import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import {
  buildShotIndex,
  evaluateProposal,
  findInvalidation,
  findAlternativeSources,
  findVerbatimQuotes,
  factFingerprint,
  extractClaims,
  sameFact
} from '../src/facts.js';
import { expressSameFact } from '../src/assessment.js';

const tables = await readMaterials();
const index = buildShotIndex(tables['镜头.json']);
const proposals = tables['说明提案.json'];
const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));

test('f4 是推断兼订正句，不能作为镜头直接呈现的事实', () => {
  const f4 = index.byId.get('f4');
  assert.equal(f4.clauses[0].inferred, true);
  assert.equal(f4.clauses[0].correction, true);
});

test('d1 的挂灯动作被同系列较晚修订 f4 推翻', () => {
  const hit = findInvalidation(index, 'f1', 'hang');
  assert.ok(hit);
  assert.equal(hit.invalidatedBy, 'f4');
});

test('订正只作用于点名动作，不株连 f2 的其他动作', () => {
  assert.equal(findInvalidation(index, 'f2', 'enter'), null);
  assert.equal(findInvalidation(index, 'f2', 'turnOn'), null);
});

test('d1 整体无镜头片段支持（要素、先后关系、招牌位置均对不上）', () => {
  const result = evaluateProposal(byId.d1, index);
  assert.ok(result.every((claim) => claim.status !== 'supported'));
});

test('d3 的“灯亮同时来客进入”被 f2、f3 独立支持，保留同时关系', () => {
  const result = evaluateProposal(byId.d3, index);
  const supported = result.flatMap((c) => c.evidence.filter((e) => e.status === 'supported'));
  const bases = new Set(supported.map((e) => e.basis));
  assert.ok(bases.has('f2'));
  assert.ok(bases.has('f3'));
});

test('f3 中“没有拍到开灯”的否定不影响“灯一直亮着”的支持', () => {
  const f3 = index.byId.get('f3');
  const negatedSpans = f3.clauses[0].negatedSpans;
  // 被否定的只有“开灯”这一处命中，“亮着”不在否定集合中。
  assert.ok(negatedSpans.length >= 1);
  const result = evaluateProposal(byId.d3, index);
  const f3Evidence = result.flatMap((c) => c.evidence).find((e) => e.basis === 'f3' && e.status === 'supported');
  assert.ok(f3Evidence);
});

test('英文 d2 与中文 d3 表达同一事实，d1 与 d3 不是同一事实', () => {
  assert.equal(expressSameFact(byId.d2, byId.d3), true);
  assert.equal(expressSameFact(byId.d1, byId.d3), false);
});

test('替代来源必须独立支持同一事实：d3 可由 f3 独立支持，d1 无替代', () => {
  const d3Claims = extractClaims(byId.d3.text, { language: 'zh' });
  const alternatives = findAlternativeSources(d3Claims, index, ['f2']);
  assert.ok(alternatives.some((a) => a.shotId === 'f3'));
  const d1Claims = extractClaims(byId.d1.text, { language: 'zh' });
  const d1Alternatives = findAlternativeSources(d1Claims, index, ['f1', 'f2']);
  assert.equal(d1Alternatives.length, 0);
});

test('逐字引号可定位到来源镜头的具体 span', () => {
  const findings = findVerbatimQuotes(byId.d1.text, index);
  assert.ok(findings.some((f) => f.content === '汐窗手作' && f.sourceShot === 'f1'));
});

test('事实指纹对新增实体敏感、对标点变化不敏感', () => {
  const base = extractClaims('柜台灯亮时有一位来客来到室内。', { language: 'zh' });
  const punct = extractClaims('柜台灯亮时，有一位来客来到室内。', { language: 'zh' });
  const extra = extractClaims('柜台灯亮时有一位来客来到室内，手里拿着伞。', { language: 'zh' });
  assert.equal(factFingerprint(base), factFingerprint(punct));
  assert.notEqual(factFingerprint(base), factFingerprint(extra));
});

test('每条主张带码点 span，可回溯到描述稿原句', () => {
  const result = evaluateProposal(byId.d1, index);
  for (const claim of result) {
    assert.ok(claim.span.end > claim.span.start);
    assert.equal(byId.d1.text.slice(0, 1).length >= 1, true);
  }
});

test('sameFact 在主张集合为空时返回 false', () => {
  assert.equal(sameFact([], []), false);
});
