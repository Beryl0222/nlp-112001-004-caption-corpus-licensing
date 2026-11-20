// 交付台账与更正管理。
//
// 台账是只追加（append-only）的 JSON 文件：交付、撤回、更正全部作为事件留存，
// 旧交付及其当时采用的许可快照永不被覆盖，保证可追溯。
//
// 去重规则：
// - 同一订购下已存在“事实指纹 + 规范化文本”均相同的有效交付时，不再重复收件；
// - 规范化只移除标点与空白差异，因此单纯分段或标点变化不会产生新交付；
// - 不同素材各自有据的文本即使文案相似，指纹不同也不会被错误合并。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { normalizeText } from './source.js';
import { factFingerprint, extractClaims } from './facts.js';

const LEDGER_VERSION = 1;

export async function loadLedger(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: LEDGER_VERSION, entries: [] };
    }
    throw error;
  }
  const ledger = JSON.parse(raw);
  if (!ledger || !Array.isArray(ledger.entries)) {
    throw new TypeError('交付台账结构不符合约定');
  }
  return ledger;
}

export async function saveLedger(file, ledger) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

function snapshotCoverage(decision) {
  // 留存当时判定所依据的许可条款快照，避免后续许可文件变化后无法复原旧结论。
  // 可交付有两种形态：直接可交付（依据在 validBasis）或替代换源（依据在 alternatives）。
  const grantedSources = new Set(decision.validBasis ?? []);
  for (const alternative of decision.alternatives ?? []) {
    if (alternative.coverage?.status === 'granted') grantedSources.add(alternative.shotId);
  }
  const coverage = decision.coverage ?? {};
  return {
    validBasis: [...grantedSources],
    grants: [...grantedSources].flatMap((source) =>
      (coverage[source]?.grants ?? []).map((grant) => ({
        source,
        licenseId: grant.licenseId,
        issuedOn: grant.issuedOn,
        clause: grant.clause,
        span: grant.span,
        period: grant.period
      }))),
    // 替代来源的授权不在 coverage 表中，从其自身 coverage 取快照。
    alternativeGrants: (decision.alternatives ?? [])
      .filter((alternative) => alternative.coverage?.status === 'granted')
      .flatMap((alternative) =>
        (alternative.coverage.grants ?? []).map((grant) => ({
          source: alternative.shotId,
          licenseId: grant.licenseId,
          issuedOn: grant.issuedOn,
          clause: grant.clause,
          span: grant.span,
          period: grant.period
        }))),
    withdrawals: Object.values(coverage).flatMap((item) =>
      (item.withdrawals ?? []).map((withdrawal) => ({
        source: item.source,
        licenseId: withdrawal.licenseId,
        issuedOn: withdrawal.issuedOn,
        clause: withdrawal.clause,
        span: withdrawal.span
      })))
  };
}

function isLive(entry, ledger) {
  if (entry.type !== 'delivery' && entry.type !== 'correction') return false;
  // 普通交付被 recall 即失效；更正版本只在其替换的原交付被撤回后存在，本身始终有效。
  if (entry.type === 'correction') return true;
  return !ledger.entries.some((other) =>
    other.type === 'recall' && other.deliveryId === entry.id);
}

function makeFingerprint(proposal) {
  return factFingerprint(extractClaims(proposal.text, { language: proposal.language }));
}

/**
 * 登记一次交付。
 * @returns {{status: 'delivered'|'duplicate', entryId?, duplicateOf?, reason}}
 */
export async function recordDelivery({
  file,
  orderId,
  proposal,
  decision,
  deliveredOn,
  force = false
}) {
  const ledger = await loadLedger(file);
  const fingerprint = makeFingerprint(proposal);
  const normalized = normalizeText(proposal.text);

  if (!force) {
    const duplicate = ledger.entries.find((entry) =>
      entry.type === 'delivery' &&
      entry.orderId === orderId &&
      isLive(entry, ledger) &&
      entry.fingerprint === fingerprint &&
      entry.normalizedText === normalized);
    if (duplicate) {
      return {
        status: 'duplicate',
        duplicateOf: duplicate.id,
        reason: '事实指纹与规范化文本均与既有交付相同（仅标点或分段差异不重复收件）'
      };
    }
  }

  const entry = {
    id: `dlv-${String(ledger.entries.length + 1).padStart(4, '0')}`,
    type: 'delivery',
    orderId,
    proposalId: proposal.id,
    deliveredOn,
    text: proposal.text,
    language: proposal.language,
    reportedBasis: proposal.reportedBasis,
    fingerprint,
    normalizedText: normalized,
    decision: decision.decision,
    licenseSnapshot: snapshotCoverage(decision),
    reasons: decision.reasons
  };
  ledger.entries.push(entry);
  await saveLedger(file, ledger);
  return { status: 'delivered', entryId: entry.id, entry };
}

/**
 * 按原交付标识发起更正：定位失去支持的旧交付，记录 recall 事件，
 * 并在提供有效替代决定时登记 corrected 版本。旧记录原样保留。
 */
export async function correctDelivery({
  file,
  deliveryId,
  reason,
  correctedOn,
  replacementProposal = null,
  replacementDecision = null
}) {
  const ledger = await loadLedger(file);
  const original = ledger.entries.find((entry) => entry.id === deliveryId && entry.type === 'delivery');
  if (!original) {
    throw new Error(`台账中找不到交付标识 ${deliveryId}`);
  }
  const alreadyRecalled = ledger.entries.some((entry) =>
    entry.type === 'recall' && entry.deliveryId === deliveryId);
  if (alreadyRecalled) {
    throw new Error(`交付 ${deliveryId} 已记录过撤回，不能重复撤回`);
  }

  const events = [];
  const recall = {
    id: `rcl-${String(ledger.entries.length + 1).padStart(4, '0')}`,
    type: 'recall',
    deliveryId,
    orderId: original.orderId,
    proposalId: original.proposalId,
    recalledOn: correctedOn,
    reason,
    supersededLicenseSnapshot: original.licenseSnapshot
  };
  ledger.entries.push(recall);
  events.push(recall);

  let replacementEntry = null;
  if (replacementProposal && replacementDecision) {
    if (!String(replacementDecision.decision).startsWith('deliverable')) {
      throw new Error('替代版本的决定不是可交付状态，不能登记为更正交付');
    }
    replacementEntry = {
      id: `dlv-${String(ledger.entries.length + 1).padStart(4, '0')}`,
      type: 'correction',
      orderId: original.orderId,
      replaces: deliveryId,
      proposalId: replacementProposal.id,
      deliveredOn: correctedOn,
      text: replacementProposal.text,
      language: replacementProposal.language,
      reportedBasis: replacementProposal.reportedBasis,
      fingerprint: makeFingerprint(replacementProposal),
      normalizedText: normalizeText(replacementProposal.text),
      decision: replacementDecision.decision,
      licenseSnapshot: snapshotCoverage(replacementDecision),
      reasons: replacementDecision.reasons
    };
    ledger.entries.push(replacementEntry);
    events.push(replacementEntry);
  }

  await saveLedger(file, ledger);
  return { recall, replacement: replacementEntry, events };
}

/** 列出当前仍有效（未被撤回）的交付，供接收方核对仍可使用的版本。 */
export function listLiveDeliveries(ledger) {
  return ledger.entries.filter((entry) => isLive(entry, ledger));
}

/** 列出某条交付的完整更正链：旧交付 → 撤回 → 更正版本。 */
export function auditTrail(ledger, deliveryId) {
  const trail = [];
  let current = ledger.entries.find((entry) => entry.id === deliveryId);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.push(current);
    if (current.type === 'recall') {
      current = ledger.entries.find((entry) => entry.type === 'correction' && entry.replaces === current.deliveryId);
    } else if (current.type === 'delivery') {
      current = ledger.entries.find((entry) => entry.type === 'recall' && entry.deliveryId === current.id);
    } else if (current.type === 'correction') {
      current = ledger.entries.find((entry) => entry.type === 'recall' && entry.deliveryId === current.replaces);
    }
  }
  return trail;
}
