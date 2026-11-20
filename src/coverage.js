// 在“指定地区 + 用途 + 语言 + 日期”的查询条件下，判断某个来源素材的许可状态。
// 状态取值：
//   granted    有明确授权且未被撤回、在期限内
//   withdrawn  曾授权，但被同一来源之后的撤回条款覆盖
//   noGrant    找不到覆盖该查询范围的授权
//   review     存在相关授权或许可记录，但范围不清楚，必须交人确认
// 每条结论都回附命中的许可条款（含原文 span），保证可追溯。

import { USE_FAMILY } from './licenses.js';

function useFamily(use) {
  return USE_FAMILY[use] ?? use;
}

function withinPeriod(grant, date) {
  const { period } = grant;
  if (!period) return { ok: true, boundaryNote: null };
  if (period.validFrom && date < period.validFrom) return { ok: false, boundaryNote: null };
  if (period.validUntil && date > period.validUntil) return { ok: false, boundaryNote: null };
  return { ok: true, boundaryNote: period.note };
}

/**
 * 地区匹配规则：
 * - 许可写明地区且与申请一致：匹配；
 * - 许可未写地区：视为不做地区限制（全国/不限地区可用），不降级为人工确认；
 * - 许可写明其他地区：不匹配；
 * - 仅“部分地区”等无法确定的措辞才标记为需人工确认。
 */
function regionMatches(grantRegion, requestedRegion, clause) {
  if (grantRegion === requestedRegion) return { match: true, unspecified: false };
  if (grantRegion === 'unspecified' || /部分地区|部分区域|特定地区/u.test(clause)) {
    return { match: true, unspecified: true };
  }
  if (grantRegion === null) {
    return { match: true, unspecified: false };
  }
  return { match: false, unspecified: false };
}

/**
 * 语言匹配规则：
 * - 许可明确列出语言时，按列表匹配；
 * - 许可未提语言时，只覆盖来源素材自身的原语言；
 * - 跨语言（翻译/双语对照）必须有明确的翻译授权或明确列出目标语言。
 */
function languageMatches(grant, requestedLanguage, sourceLanguage, translationAllowed) {
  if (grant.languages.includes(requestedLanguage)) {
    return { match: true, unspecified: false, translated: false };
  }
  if (grant.languages.length === 0) {
    if (requestedLanguage === sourceLanguage) {
      return { match: true, unspecified: false, translated: false };
    }
    if (translationAllowed && grant.translationAllowed) {
      return { match: true, unspecified: false, translated: true };
    }
    return { match: false, unspecified: false, translated: false };
  }
  return { match: false, unspecified: false, translated: false };
}

function withdrawalMatches(withdrawal, licenseIssuedOn, query) {
  // 撤回只在其签发日期之后（含当日）生效；查询日期早于撤回时，原授权仍有效。
  if (licenseIssuedOn && licenseIssuedOn > query.date) return false;
  if (withdrawal.region !== null && withdrawal.region !== query.region) return false;
  if (withdrawal.useFamilies.length > 0 &&
      !withdrawal.useFamilies.includes(useFamily(query.use))) {
    return false;
  }
  if (withdrawal.languages.length > 0 &&
      !withdrawal.languages.includes(query.language)) {
    return false;
  }
  return true;
}

/**
 * @param parsedLicenses parseLicenses 的输出
 * @param sourceId 素材编号（如 f2）
 * @param sourceLanguage 素材原语言
 * @param query { region, use, language, date }
 */
export function checkCoverage(parsedLicenses, sourceId, sourceLanguage, query) {
  const family = useFamily(query.use);
  const own = parsedLicenses.filter((license) => license.source === sourceId);
  const reviewReasons = [];
  const matchedGrants = [];
  const matchedWithdrawals = [];
  const restrictions = [];

  for (const license of own) {
    let licenseHasMatch = false;
    for (const withdrawal of license.withdrawals) {
      if (withdrawalMatches(withdrawal, license.issuedOn, query)) {
        matchedWithdrawals.push({ ...withdrawal, issuedOn: license.issuedOn });
        licenseHasMatch = true;
      }
    }
    for (const grant of license.grants) {
      const region = regionMatches(grant.region, query.region, grant.clause);
      if (!region.match) continue;
      if (grant.useFamilies.length > 0 && !grant.useFamilies.includes(family)) continue;
      const language = languageMatches(grant, query.language, sourceLanguage, true);
      if (!language.match) continue;
      const period = withinPeriod(grant, query.date);
      if (!period.ok) continue;

      licenseHasMatch = true;
      if (region.unspecified) {
        reviewReasons.push({
          reason: '许可未写明地区，是否覆盖申请地区需人工确认',
          licenseId: license.id,
          clause: grant.clause,
          span: grant.span
        });
      }
      if (period.boundaryNote) {
        reviewReasons.push({
          reason: period.boundaryNote,
          licenseId: license.id,
          clause: grant.clause,
          span: grant.span
        });
      }
      matchedGrants.push({
        licenseId: license.id,
        issuedOn: license.issuedOn,
        clause: grant.clause,
        span: grant.span,
        period: grant.period,
        translationAllowed: grant.translationAllowed
      });
    }
    for (const restriction of license.restrictions) {
      restrictions.push({
        licenseId: license.id,
        ...restriction
      });
    }
    // 讨论类措辞只有在该许可与当前查询相关（命中授权/撤回）且语言对得上时才构成 review 依据，
    // 避免“中文可继续讨论”干扰一条独立的英文授权判断。
    if (licenseHasMatch) {
      for (const unresolved of license.unresolved) {
        if (unresolved.clause.includes('中文') && query.language !== 'zh') continue;
        if (unresolved.clause.includes('英文') && query.language !== 'en') continue;
        reviewReasons.push({
          reason: unresolved.reason,
          licenseId: license.id,
          clause: unresolved.clause,
          span: unresolved.span
        });
      }
    }
  }

  // 撤回优先：命中查询范围的撤回条款使对应授权失效。
  if (matchedWithdrawals.length > 0 && matchedGrants.length > 0) {
    const blocking = matchedWithdrawals.find((w) =>
      matchedGrants.some((g) => g.licenseId !== w.licenseId || true));
    return {
      status: 'withdrawn',
      source: sourceId,
      query,
      grants: matchedGrants,
      withdrawals: matchedWithdrawals,
      restrictions,
      reviewReasons,
      explanation: `授权已被撤回条款覆盖（${matchedWithdrawals.map((w) => w.licenseId).join('、')}）`
    };
  }

  if (matchedGrants.length === 0) {
    return {
      status: matchedWithdrawals.length > 0 ? 'withdrawn' : 'noGrant',
      source: sourceId,
      query,
      grants: [],
      withdrawals: matchedWithdrawals,
      restrictions,
      reviewReasons,
      explanation: matchedWithdrawals.length > 0
        ? '相关许可已撤回且无新的授权覆盖该范围'
        : '没有许可条款覆盖该地区、用途、语言与期限'
    };
  }

  if (reviewReasons.length > 0) {
    return {
      status: 'review',
      source: sourceId,
      query,
      grants: matchedGrants,
      withdrawals: matchedWithdrawals,
      restrictions,
      reviewReasons,
      explanation: '授权范围存在不明确项，需人工确认后方可交付'
    };
  }

  return {
    status: 'granted',
    source: sourceId,
    query,
    grants: matchedGrants,
    withdrawals: matchedWithdrawals,
    restrictions,
    reviewReasons: [],
    explanation: `命中 ${matchedGrants.map((g) => g.licenseId).join('、')} 的明确授权`
  };
}
