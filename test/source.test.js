import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseSourceIds,
  splitClauses,
  normalizeText,
  findSpan,
  sliceByCodePoints
} from '../src/source.js';

test('reportedBasis 容忍顿号、逗号与空格，按顺序取出素材编号', () => {
  assert.deepEqual(parseSourceIds('f1、f2'), ['f1', 'f2']);
  assert.deepEqual(parseSourceIds('f1, f3；f2'), ['f1', 'f3', 'f2']);
  assert.deepEqual(parseSourceIds(''), []);
});

test('小句切分保留码点偏移，且偏移与切片一致', () => {
  const text = '柜台上一盏灯先亮，来客转身推开侧门。';
  const clauses = splitClauses(text);
  assert.ok(clauses.length >= 1);
  for (const clause of clauses) {
    assert.equal(sliceByCodePoints(text, clause.span.start, clause.span.end), clause.text);
  }
});

test('规范化只忽略标点与空白，不改变文字事实', () => {
  const a = '柜台灯亮时，有一位来客来到室内。';
  const b = '柜台灯亮时 有一位来客来到室内';
  assert.equal(normalizeText(a), normalizeText(b));
  const c = '柜台灯亮时有一位来客来到室外。';
  assert.notEqual(normalizeText(a), normalizeText(c));
});

test('findSpan 返回码点范围并能还原原文', () => {
  const text = '招牌写着“汐窗手作”。';
  const span = findSpan(text, '汐窗手作');
  assert.ok(span);
  assert.equal(sliceByCodePoints(text, span.start, span.end), '汐窗手作');
  assert.equal(findSpan(text, '不存在的内容'), null);
});

test('码点切片对增补字符安全', () => {
  const text = 'a😀b';
  assert.equal(sliceByCodePoints(text, 0, 3), 'a😀b');
  assert.equal(sliceByCodePoints(text, 1, 2), '😀');
});
