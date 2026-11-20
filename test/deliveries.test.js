import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  loadLedger,
  recordDelivery,
  correctDelivery,
  auditTrail,
  listLiveDeliveries
} from '../src/deliveries.js';

const decision = (overrides = {}) => ({
  decision: 'deliverable',
  validBasis: ['f3'],
  coverage: { f3: { grants: [{ licenseId: 'l3', issuedOn: '2026-09-03', clause: 'x', span: { start: 0, end: 1 }, period: null }], withdrawals: [] } },
  reasons: ['命中 l3'],
  ...overrides
});

const proposal = (id, text) => ({ id, language: 'zh', text, reportedBasis: 'f3' });

async function withLedger(run) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-'));
  try {
    await run(join(dir, 'ledger.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('交付记录留存当时的许可快照，旧依据可追溯', async () => {
  await withLedger(async (file) => {
    const out = await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    assert.equal(out.status, 'delivered');
    const ledger = await loadLedger(file);
    const entry = ledger.entries[0];
    assert.equal(entry.licenseSnapshot.grants[0].licenseId, 'l3');
  });
});

test('替代换源交付时，快照留存替代来源的授权条款', async () => {
  await withLedger(async (file) => {
    const alternativeDecision = decision({
      decision: 'deliverableWithAlternative',
      validBasis: [],
      alternatives: [{
        shotId: 'f2',
        coverage: {
          status: 'granted',
          grants: [{ licenseId: 'l2', issuedOn: '2026-09-01', clause: 'c', span: { start: 0, end: 1 }, period: null }],
          withdrawals: []
        }
      }]
    });
    const out = await recordDelivery({
      file, orderId: 'o2', proposal: proposal('d2', 'The shop lamp is on.'),
      decision: alternativeDecision, deliveredOn: '2026-09-08'
    });
    assert.equal(out.entry.licenseSnapshot.alternativeGrants[0].licenseId, 'l2');
    assert.deepEqual(out.entry.licenseSnapshot.validBasis, ['f2']);
  });
});

test('仅标点或分段变化不产生重复收件', async () => {
  await withLedger(async (file) => {
    await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    const dup = await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时，有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-13'
    });
    assert.equal(dup.status, 'duplicate');
  });
});

test('不同事实的相似文本不会被合并', async () => {
  await withLedger(async (file) => {
    await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    const second = await recordDelivery({
      file, orderId: 'o3',
      proposal: proposal('d3x', '柜台灯亮时有一位来客来到室内，手里拿着伞。'),
      decision: decision(), deliveredOn: '2026-09-13'
    });
    assert.equal(second.status, 'delivered');
  });
});

test('撤回与更正形成完整链条，旧交付保留且更正版本生效', async () => {
  await withLedger(async (file) => {
    const delivered = await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    const outcome = await correctDelivery({
      file, deliveryId: delivered.entryId, reason: '原依据许可被撤回',
      correctedOn: '2026-09-20',
      replacementProposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      replacementDecision: decision()
    });
    assert.equal(outcome.recall.type, 'recall');
    assert.equal(outcome.replacement.type, 'correction');
    const ledger = await loadLedger(file);
    const trail = auditTrail(ledger, delivered.entryId).map((e) => e.type);
    assert.deepEqual(trail, ['delivery', 'recall', 'correction']);
    const live = listLiveDeliveries(ledger);
    assert.equal(live.length, 1);
    assert.equal(live[0].type, 'correction');
    // 旧交付条目仍在台账中，未被覆盖。
    assert.ok(ledger.entries.some((e) => e.id === delivered.entryId && e.type === 'delivery'));
  });
});

test('同一交付不能重复撤回', async () => {
  await withLedger(async (file) => {
    const delivered = await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    await correctDelivery({ file, deliveryId: delivered.entryId, reason: 'first', correctedOn: '2026-09-20' });
    await assert.rejects(
      correctDelivery({ file, deliveryId: delivered.entryId, reason: 'second', correctedOn: '2026-09-21' }),
      /已记录过撤回/
    );
  });
});

test('非可交付状态的替代版本不能登记为更正', async () => {
  await withLedger(async (file) => {
    const delivered = await recordDelivery({
      file, orderId: 'o3', proposal: proposal('d3', '柜台灯亮时有一位来客来到室内。'),
      decision: decision(), deliveredOn: '2026-09-12'
    });
    await assert.rejects(
      correctDelivery({
        file, deliveryId: delivered.entryId, reason: 'x', correctedOn: '2026-09-20',
        replacementProposal: proposal('d3', 'x'),
        replacementDecision: decision({ decision: 'needsCorrection' })
      }),
      /不是可交付状态/
    );
  });
});
