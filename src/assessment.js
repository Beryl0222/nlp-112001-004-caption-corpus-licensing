// 订购评估：把事实派生结论与许可覆盖结论合并，给出每条语料的决定与理由。
//
// 决定（decision）：
//   deliverable     事实有据、许可覆盖、无限制冲突，可按现状交付
//   needsCorrection 事实无据/被修订推翻/逐字限制冲突/授权撤回或缺失，必须更正
//   review          存在相关授权但范围不清楚，交人确认，不得自动放行
//
// 替代来源规则：另一素材必须“独立支持同一事实”，且其许可覆盖当前用途；
// 仅文案相似不构成替代。替代来源许可不清时只列入待确认，不自动替换。

import {
  evaluateProposal,
  factFingerprint,
  findAlternativeSources,
  findInvalidation,
  findVerbatimQuotes,
  extractClaims
} from './facts.js';
import { checkCoverage } from './coverage.js';
import { parseSourceIds } from './source.js';
import { entailedConcepts, expandAction, expandConcept } from './rules.js';

/** 带等价类与蕴含规则的同一事实判断。 */
export function expressSameFact(proposalA, proposalB) {
  const claimsA = extractClaims(proposalA.text, { language: proposalA.language });
  const claimsB = extractClaims(proposalB.text, { language: proposalB.language });
  if (claimsA.length !== claimsB.length || claimsA.length === 0) return false;

  for (let i = 0; i < claimsA.length; i += 1) {
    const a = claimsA[i];
    const b = claimsB[i];

    const actionsA = new Set(a.actions.map((item) => item.key));
    const actionsB = new Set(b.actions.map((item) => item.key));
    for (const key of actionsA) {
      if ([...expandAction(key)].every((candidate) => !actionsB.has(candidate))) return false;
    }
    for (const key of actionsB) {
      if ([...expandAction(key)].every((candidate) => !actionsA.has(candidate))) return false;
    }

    // residual 是各语言的表层实词，跨语言不可比，只比较词表中的规范概念。
    const canonical = (claim) => claim.concepts
      .map((item) => item.key)
      .filter((key) => !key.startsWith('residual:'));
    const conceptsA = new Set([...canonical(a), ...entailedConcepts([...actionsA])]);
    const conceptsB = new Set([...canonical(b), ...entailedConcepts([...actionsB])]);
    for (const key of conceptsA) {
      if ([...expandConcept(key)].every((candidate) => !conceptsB.has(candidate))) return false;
    }
    for (const key of conceptsB) {
      if ([...expandConcept(key)].every((candidate) => !conceptsA.has(candidate))) return false;
    }

    if ((a.relation?.type ?? null) !== (b.relation?.type ?? null)) return false;
  }
  return true;
}

function sourceLanguage(shotIndex, sourceId) {
  return shotIndex.byId.get(sourceId)?.language ?? null;
}

function evaluateCoverageForSources(sourceIds, shotIndex, parsedLicenses, query) {
  const results = {};
  for (const sourceId of sourceIds) {
    const language = sourceLanguage(shotIndex, sourceId);
    if (!language) {
      results[sourceId] = { status: 'noGrant', explanation: '来源镜头不存在' };
      continue;
    }
    results[sourceId] = checkCoverage(parsedLicenses, sourceId, language, query);
  }
  return results;
}

function verbatimViolations(proposal, shotIndex, parsedLicenses) {
  const quotes = findVerbatimQuotes(proposal.text, shotIndex);
  const violations = [];
  for (const quote of quotes) {
    const licenses = parsedLicenses.filter((license) => license.source === quote.sourceShot);
    const forbidding = licenses.flatMap((license) =>
      license.restrictions
        .filter((restriction) => restriction.type === 'verbatimForbidden')
        .map((restriction) => ({ licenseId: license.id, clause: restriction.clause, span: restriction.span }))
    );
    if (forbidding.length > 0) {
      violations.push({ quote, forbidding });
    }
  }
  return violations;
}

/**
 * 评估单个订购单。
 * @param {object} params
 * @param {object} params.order 订购记录（可带可选 parallel 字段要求中英对照）
 * @param {Array} params.proposals 说明提案记录
 * @param {object} params.shotIndex buildShotIndex 的结果
 * @param {Array} params.parsedLicenses parseLicenses 的结果
 * @param {string} params.date 评估日期 ISO，默认取订购 requestedOn
 */
export function evaluateOrder({ order, proposals, shotIndex, parsedLicenses, date }) {
  const effectiveDate = date ?? order.requestedOn;
  const query = {
    region: order.region,
    use: order.use,
    language: order.language,
    date: effectiveDate
  };
  const requireParallel = order.parallel === true || order.parallel === 'true';

  const proposalResults = proposals
    .filter((proposal) => proposal.language === order.language)
    .map((proposal) => evaluateOne({ proposal, query, shotIndex, parsedLicenses }));

  const parallelReport = requireParallel
    ? buildParallelReport({ order, proposals, shotIndex, parsedLicenses, query, effectiveDate })
    : null;

  return {
    orderId: order.id,
    query,
    parallelRequired: requireParallel,
    decisions: proposalResults,
    parallelReport,
    summary: summarize(proposalResults)
  };
}

function evaluateOne({ proposal, query, shotIndex, parsedLicenses }) {
  const claimResults = evaluateProposal(proposal, shotIndex);
  const basisIds = [...new Set(parseSourceIds(proposal.reportedBasis))];
  const coverage = evaluateCoverageForSources(basisIds, shotIndex, parsedLicenses, query);
  const violations = verbatimViolations(proposal, shotIndex, parsedLicenses);

  const reasons = [];

  // 事实层面：无据、被修订推翻、推断冒充直接事实。
  const factualBlockers = [];
  for (const claim of claimResults) {
    const invalidations = basisIds
      .flatMap((basisId) =>
        claim.actions.map((action) => ({ basisId, action: action.key, hit: findInvalidation(shotIndex, basisId, action.key) }))
      )
      .filter((entry) => entry.hit);

    if (claim.status === 'unsupported') {
      const detail = {
        claimIndex: claim.claimIndex,
        clause: claim.clause,
        span: claim.span,
        reason: 'reportedBasis 中的镜头片段无法独立支持该主张（要素或先后关系对不上）'
      };
      factualBlockers.push(detail);
      reasons.push(`主张「${claim.clause}」没有镜头片段支持`);
    } else if (claim.status === 'invalidated') {
      factualBlockers.push({ claimIndex: claim.claimIndex, clause: claim.clause, span: claim.span, invalidations });
      reasons.push(`主张「${claim.clause}」已被同系列较晚修订推翻`);
    } else if (claim.status === 'inferred') {
      factualBlockers.push({
        claimIndex: claim.claimIndex,
        clause: claim.clause,
        span: claim.span,
        reason: '该表达来自画面推断，不能写成镜头直接呈现的事实'
      });
      reasons.push(`主张「${claim.clause}」属于推断，不能作为直接事实交付`);
    }
  }

  for (const violation of violations) {
    reasons.push(
      `逐字保留了 ${violation.quote.sourceShot} 中的「${violation.quote.content}」，` +
      `但 ${violation.forbidding.map((item) => item.licenseId).join('、')} 明确禁止逐字保留`
    );
  }

  // 许可层面：只对“实际支撑了事实”的来源做交付判断；未参与支撑的来源从有效依据中剔除。
  const neededSources = new Set();
  for (const claim of claimResults) {
    for (const evidence of claim.evidence) {
      if (evidence.status === 'supported') neededSources.add(evidence.basis);
    }
  }
  const validBasis = [];
  const blockedBasis = [];
  for (const sourceId of basisIds) {
    const item = coverage[sourceId];
    const needed = neededSources.has(sourceId);
    const entry = {
      source: sourceId,
      needed,
      status: item?.status,
      explanation: item?.explanation,
      grants: item?.grants ?? [],
      withdrawals: item?.withdrawals ?? [],
      reviewReasons: item?.reviewReasons ?? []
    };
    if (!needed) {
      blockedBasis.push({ ...entry, reason: '该来源未实际支撑任何交付主张，应从依据中移除' });
      continue;
    }
    if (item.status === 'granted') validBasis.push(entry);
    else blockedBasis.push(entry);
  }

  // 对失去支持的主张寻找替代素材：必须独立支持同一事实，再查替代素材的许可。
  const lostSources = blockedBasis
    .filter((entry) => entry.needed && ['withdrawn', 'noGrant'].includes(entry.status))
    .map((entry) => entry.source);
  const claims = extractClaims(proposal.text, { language: proposal.language });
  const alternatives = lostSources.length === 0
    ? []
    : findAlternativeSources(claims, shotIndex, lostSources).map((alternative) => {
        const alternativeCoverage = checkCoverage(
          parsedLicenses,
          alternative.shotId,
          sourceLanguage(shotIndex, alternative.shotId),
          query
        );
        return { ...alternative, coverage: alternativeCoverage };
      });

  const coverageReview = blockedBasis.some((entry) => entry.needed && entry.status === 'review') ||
    alternatives.some((alternative) => alternative.coverage.status === 'review');
  const coverageDenied = blockedBasis.some((entry) => entry.needed &&
    ['withdrawn', 'noGrant'].includes(entry.status));

  let decision;
  if (factualBlockers.length > 0 || violations.length > 0) {
    decision = 'needsCorrection';
  } else if (coverageDenied) {
    const usableAlternative = alternatives.some((alternative) => alternative.coverage.status === 'granted');
    decision = usableAlternative ? 'deliverableWithAlternative' : 'needsCorrection';
  } else if (coverageReview) {
    decision = 'review';
  } else {
    decision = 'deliverable';
  }

  if (coverageDenied) {
    reasons.push(`依据来源 ${lostSources.join('、')} 在当前地区/用途/语言/期限下无有效授权`);
  }
  for (const entry of blockedBasis) {
    if (entry.needed && entry.status === 'review') {
      reasons.push(`来源 ${entry.source} 的许可范围不清楚，需人工确认：${entry.reviewReasons.map((r) => r.reason).join('；')}`);
    }
  }
  for (const alternative of alternatives) {
    if (alternative.coverage.status === 'granted') {
      reasons.push(`可改用独立支持同一事实的素材 ${alternative.shotId}（${alternative.coverage.explanation}）`);
    } else {
      reasons.push(`替代素材 ${alternative.shotId} 的许可状态为 ${alternative.coverage.status}，不得自动替换，需人工确认`);
    }
  }

  return {
    proposalId: proposal.id,
    language: proposal.language,
    text: proposal.text,
    reportedBasis: proposal.reportedBasis,
    decision,
    fingerprint: factFingerprint(claims),
    claimResults,
    coverage,
    validBasis: validBasis.map((entry) => entry.source),
    blockedBasis,
    alternatives,
    restrictionViolations: violations,
    reasons
  };
}

function buildParallelReport({ order, proposals, shotIndex, parsedLicenses, query }) {
  const zh = proposals.filter((proposal) => proposal.language === 'zh');
  const en = proposals.filter((proposal) => proposal.language === 'en');
  const pairs = [];
  for (const zhProposal of zh) {
    for (const enProposal of en) {
      if (!expressSameFact(zhProposal, enProposal)) continue;
      const zhResult = evaluateOne({
        proposal: zhProposal,
        query: { ...query, language: 'zh' },
        shotIndex,
        parsedLicenses
      });
      const enResult = evaluateOne({
        proposal: enProposal,
        query: { ...query, language: 'en' },
        shotIndex,
        parsedLicenses
      });
      const bothLicensed = zhResult.decision.startsWith('deliverable') &&
        enResult.decision.startsWith('deliverable');
      pairs.push({
        zh: zhProposal.id,
        en: enProposal.id,
        sameFact: true,
        parallelLabelAllowed: bothLicensed,
        zhDecision: zhResult.decision,
        enDecision: enResult.decision,
        note: bothLicensed
          ? '两端表达同一事实且各自许可覆盖，可标为中英对照语料'
          : '两端虽表达同一事实，但至少一端许可不覆盖对应语言；单语材料可按其自身决定处理，不得标成双语对照'
      });
    }
  }
  return { orderId: order.id, pairs };
}

function summarize(decisions) {
  const counts = { deliverable: 0, deliverableWithAlternative: 0, needsCorrection: 0, review: 0 };
  for (const item of decisions) counts[item.decision] = (counts[item.decision] ?? 0) + 1;
  return counts;
}
