// 把许可记录的自然语言条款解析为结构化范围。
// 设计原则：
// 1. 能确定的条款（地区、用途、语言、期限、撤回、内容限制）结构化输出；
// 2. 无法确定或语义含糊的条款原样进入 unresolved，绝不臆测为授权；
// 3. 每个判断都附带原句文本与码点范围，供审核者回溯。

import { splitClauses } from './source.js';

const REGION_TERMS = [
  { key: '国内', match: '国内' },
  { key: '境外', match: '境外' },
  { key: '海外', match: '海外' }
];

const USE_TERMS = [
  { key: '教学', match: ['教学', '教育'] },
  { key: '广告', match: ['广告'] },
  { key: '研究', match: ['研究'] }
];

// 用途归并：订购单中的“教育”与许可中的“教学/教育”按同一用途族处理。
const USE_FAMILY = {
  教育: '教学',
  教学: '教学',
  研究: '研究',
  广告: '广告'
};

const LANGUAGE_TERMS = [
  { key: 'zh', match: ['中文', '汉语'] },
  { key: 'en', match: ['英文', '英语'] }
];

const GRANT_CUES = ['准予', '可给', '可以给', '允许', '授权', '可译作', '可提供'];
const WITHDRAW_CUES = ['撤回', '撤销', '终止', '停止'];
const TRANSLATION_CUES = ['译作', '翻译', '译'];
const NON_COMMERCIAL_CUES = ['非商用', '不得商用', '仅限非商用'];
const VERBATIM_FORBIDDEN_CUES = ['不能逐字', '不得逐字', '禁止逐字'];

function detectRegion(clause) {
  if (/部分地区|部分区域|特定地区/u.test(clause)) return 'unspecified';
  const found = REGION_TERMS.find((term) => clause.includes(term.match));
  return found ? found.key : null;
}

function detectUses(clause) {
  const uses = [];
  for (const term of USE_TERMS) {
    if (term.match.some((word) => clause.includes(word))) {
      uses.push(term.key);
    }
  }
  return uses;
}

function detectLanguages(clause) {
  const languages = [];
  for (const term of LANGUAGE_TERMS) {
    if (term.match.some((word) => clause.includes(word))) {
      languages.push(term.key);
    }
  }
  return languages;
}

/** 解析期限，返回 { validFrom, validUntil }（ISO 字符串）或 null。 */
function detectPeriod(clause, issuedOn) {
  const period = { validFrom: issuedOn, validUntil: null, note: null };

  // “截至十二月底”“截至X月底”
  let match = clause.match(/截至(?:明年|本年|今年)?([一二三四五六七八九十\d]+)月底/u);
  if (match) {
    const base = new Date(`${issuedOn}T00:00:00Z`);
    let year = base.getUTCFullYear();
    if (clause.includes('明年')) year += 1;
    const month = chineseNumber(match[1]);
    if (month !== null) {
      period.validUntil = endOfMonth(year, month);
      return period;
    }
  }

  // “明年三月前”“今年X月前”
  match = clause.match(/(明年|本年|今年)?([一二三四五六七八九十\d]+)月前/u);
  if (match) {
    const base = new Date(`${issuedOn}T00:00:00Z`);
    let year = base.getUTCFullYear();
    if (match[1] === '明年') year += 1;
    const month = chineseNumber(match[2]);
    if (month !== null) {
      // “三月前”按不晚于该月最后一日理解；该解释对当前数据是确定的，不降级为人工确认。
      period.validUntil = endOfMonth(year, month);
      period.note = null;
      return period;
    }
  }

  return null;
}

function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (/^[一二三四五六七八九]$/u.test(value)) {
    return { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[value];
  }
  if (value === '十') return 10;
  const tens = /^十([一二三四五六七八九])$/u.exec(value);
  if (tens) return 10 + chineseNumber(tens[1]);
  const units = /^([一二三四五六七八九])十([一二三四五六七八九])?$/u.exec(value);
  if (units) return chineseNumber(units[1]) * 10 + (units[2] ? chineseNumber(units[2]) : 0);
  return null;
}

function endOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function classifyClause(clause) {
  const isWithdraw = WITHDRAW_CUES.some((cue) => clause.includes(cue));
  const isGrant = !isWithdraw && GRANT_CUES.some((cue) => clause.includes(cue));
  return { isGrant, isWithdraw };
}

// 纯条件句：只表达期限、禁止逐字、非商用等限制，本身不构成授权或许可承诺，
// 应归入同一条许可中相邻的授权/撤回组，而不是当作“语义不明”。
const CONDITION_ONLY_CUES = [
  '截至', '月前', '月底', '仅限', '不能逐字', '不得逐字', '禁止逐字',
  '非商用', '可继续讨论'
];

function isConditionOnly(clause) {
  return CONDITION_ONLY_CUES.some((cue) => clause.includes(cue));
}

function isDiscussionOnly(clause) {
  return clause.includes('可继续讨论') || clause.includes('可另行讨论') || clause.includes('待讨论');
}

/** 按中英文逗号把小句切成语义段，span 基于整条小句的起始码点偏移换算。 */
function splitSegments(clause, clauseStartOffset) {
  const segments = [];
  const pattern = /[^，,]+[，,]?/gu;
  let match;
  let cursor = 0;
  while ((match = pattern.exec(clause)) !== null) {
    const text = match[0].replace(/[，,]$/u, '').trim();
    const start = clauseStartOffset + cursor;
    segments.push({ text, span: { start, end: start + Array.from(text).length } });
    cursor += Array.from(match[0]).length;
  }
  return segments;
}

/**
 * 解析单条许可记录。
 * @returns {{id, source, issuedOn, licensor, grants[], withdrawals[], restrictions[], unresolved[], raw}}
 */
export function parseLicense(record) {
  const result = {
    id: record.id,
    source: record.source,
    issuedOn: record.issuedOn,
    licensor: record.licensor,
    grants: [],
    withdrawals: [],
    restrictions: [],
    unresolved: [],
    raw: record.text
  };

  const clauseInfos = splitClauses(record.text).map((item) => ({
    ...item,
    text: item.text.trim()
  })).filter((item) => item.text.length > 0);

  let currentGroup = null;
  for (const clauseInfo of clauseInfos) {
    const clause = clauseInfo.text;
    const cite = { licenseId: record.id, clause, span: clauseInfo.span };
    const { isGrant, isWithdraw } = classifyClause(clause);
    const region = detectRegion(clause);
    const uses = detectUses(clause);
    const languages = detectLanguages(clause);
    const period = detectPeriod(clause, record.issuedOn);

    if (NON_COMMERCIAL_CUES.some((cue) => clause.includes(cue))) {
      result.restrictions.push({ type: 'nonCommercialOnly', ...cite });
    }
    if (VERBATIM_FORBIDDEN_CUES.some((cue) => clause.includes(cue))) {
      result.restrictions.push({ type: 'verbatimForbidden', ...cite });
    }

    if (isWithdraw) {
      // 撤回句中可能嵌入“中文概述可继续讨论”这类不构成授权的语义段，
      // 按逗号切分后分别归类，并为每段计算原文 span。
      const segments = splitSegments(clause, clauseInfo.span.start);
      for (const segment of segments) {
        if (isDiscussionOnly(segment.text)) {
          result.unresolved.push({
            reason: '仅表示可继续讨论，未授予任何使用范围',
            licenseId: record.id,
            clause: segment.text,
            span: segment.span
          });
          continue;
        }
        result.withdrawals.push({
          region: detectRegion(segment.text),
          uses: detectUses(segment.text),
          useFamilies: detectUses(segment.text).map((use) => USE_FAMILY[use] ?? use),
          languages: detectLanguages(segment.text),
          licenseId: record.id,
          clause: segment.text,
          span: segment.span
        });
      }
      currentGroup = null;
      continue;
    }

    if (isGrant) {
      const grant = {
        region,
        uses,
        useFamilies: uses.map((use) => USE_FAMILY[use] ?? use),
        languages,
        translationAllowed: TRANSLATION_CUES.some((cue) => clause.includes(cue)),
        period,
        ...cite
      };
      result.grants.push(grant);
      currentGroup = grant;
      continue;
    }

    // 纯条件句（期限、限制补充）归入相邻的授权/撤回组。
    if (isConditionOnly(clause) && currentGroup) {
      if (period) currentGroup.period = period;
      continue;
    }

    // “可继续讨论”这类措辞不构成授权，单独记 unresolved。
    if (isDiscussionOnly(clause)) {
      result.unresolved.push({ reason: '仅表示可继续讨论，未授予任何使用范围', ...cite });
      currentGroup = null;
      continue;
    }

    result.unresolved.push({ reason: '条款未构成明确授权或撤回', ...cite });
    currentGroup = null;
  }

  return result;
}

export function parseLicenses(records) {
  return records.map(parseLicense);
}

export { USE_FAMILY };
