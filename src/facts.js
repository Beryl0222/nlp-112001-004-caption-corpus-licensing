// 事实派生与镜头支持判断。
//
// 规则全部显式声明（词表 + 提示词），不做黑箱相似度判断：
// - 逐字转录、错字订正、翻译、概括都以“概念/动作/先后关系”的保留情况来衡量；
// - 画面推断（倒影、推测等）不能当作镜头直接呈现的事实，也不能支持直接事实主张；
// - 同一 series 的较晚 revision 若含订正提示，可推翻较早记录中的对应动作主张；
// - 每条主张都带码点 span，可回溯到描述稿原句；支持结论回附镜头原句 span。

import { codePointOffset, findSpan, normalizeText, parseSourceIds, sliceByCodePoints, splitClauses, textAt } from './source.js';
import { entailedConcepts, expandAction, expandConcept } from './rules.js';

// 概念词表：匹配词按长度降序匹配，避免短词抢先命中。
const CONCEPTS = [
  { key: 'clerk', zh: ['女店员', '店员'], en: ['clerk', 'shopkeeper', 'attendant'] },
  { key: 'guest', zh: ['来客', '客人'], en: ['guest', 'visitor'] },
  { key: 'lamp', zh: ['柜台灯', '一盏灯', '灯'], en: ['shop lamp', 'counter lamp', 'lamp'] },
  { key: 'sideDoor', zh: ['侧门'], en: ['side door'] },
  { key: 'counter', zh: ['柜台'], en: ['counter'] },
  { key: 'signboard', zh: ['招牌', '蓝招牌'], en: ['signboard', 'sign'] },
  { key: 'shopWindow', zh: ['橱窗'], en: ['shop window', 'showcase'] },
  { key: 'doorEdge', zh: ['门边', '门旁'], en: ['door edge', 'beside the door'] },
  { key: 'reflection', zh: ['倒影'], en: ['reflection'] },
  { key: 'interior', zh: ['室内'], en: ['indoors', 'interior'] }
];

const ACTIONS = [
  {
    key: 'hang',
    zh: ['挂起', '挂好', '挂灯', '挂'],
    en: ['hang', 'hangs', 'hung', 'hanging']
  },
  {
    key: 'turnOn',
    zh: ['开灯', '亮起', '亮着', '先亮', '灯亮'],
    en: ['turn on', 'turns on', 'is on', 'is already on', 'lights', 'lit']
  },
  {
    key: 'enter',
    zh: ['入内', '进来', '推开侧门', '推门', '进入'],
    en: ['enter', 'enters', 'entered', 'entering', 'comes in', 'came in']
  },
  {
    key: 'turn',
    zh: ['转身'],
    en: ['turn', 'turns', 'turned']
  },
  {
    key: 'write',
    zh: ['写着', '写有'],
    en: ['read', 'reads', 'say', 'says', 'said']
  },
  {
    key: 'arrive',
    zh: ['来到', '到达'],
    en: ['arrive', 'arrives', 'arrived']
  }
];

// 先后关系提示词。
const ORDER_CUES = [
  { key: 'after', zh: ['后', '之后', '然后'], en: ['after', 'then'] },
  { key: 'before', zh: ['先', '之前'], en: ['before'] }
];
const SIMULTANEOUS_CUES = { zh: ['时', '同时'], en: ['when', 'while', 'as'] };

// 画面推断提示：出现这些词说明是推断而非镜头直接呈现。
const INFERENCE_CUES = {
  zh: ['倒影', '推断', '推测', '似乎', '好像', '无法据此确认'],
  en: ['inference', 'inferred', 'seems', 'appears', 'reflection', 'cannot confirm']
};

// 较晚修订中的订正提示。
const CORRECTION_CUES = {
  zh: ['重校', '订正', '更正', '无法据此确认', '不能确认'],
  en: ['recheck', 'correction', 'corrected', 'cannot confirm']
};

// 否定提示：被否定的动作不是镜头呈现的事实，不能支持对应主张。
// 仅按局部作用域生效——否定词之后到逗号/句读之前的动作才算被否定。
const NEGATION_CUES = {
  zh: ['没有拍到', '未拍到', '并未拍到', '没有', '并未', '无法'],
  en: ['not filmed', 'not shown', 'did not', 'never']
};

const NEGATION_SCOPE_BREAK = /[，,。；;]/u;

const QUOTE_PATTERN = /[“"「『]([^”"」』]+)[”"」』]/gu;

function hasCue(text, cues) {
  return cues.some((cue) => text.includes(cue));
}

function detectLanguage(text) {
  return /[一-鿿]/u.test(text) ? 'zh' : 'en';
}

function englishWordBoundaryMatch(text, word) {
  // 对含空格/连字符的多词短语使用转义子串；单词保留词边界，避免 on 命中 mon 之类。
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /[\s-]/u.test(word)
    ? new RegExp(escaped, 'iu')
    : new RegExp(`\\b${escaped}\\b`, 'iu');
  const match = text.match(pattern);
  return match ? match.index : -1;
}

/** 在文本中查找词表命中，返回 { key, term, span } 列表，按词表顺序优先。 */
function detectLexicon(text, lexicon, language) {
  const hits = [];
  const occupied = [];
  const ordered = [...lexicon].sort((a, b) => {
    const wordsA = language === 'zh' ? a.zh : a.en;
    const wordsB = language === 'zh' ? b.zh : b.en;
    return Math.max(...wordsB.map((w) => w.length)) - Math.max(...wordsA.map((w) => w.length));
  });
  for (const entry of ordered) {
    const words = language === 'zh' ? entry.zh : entry.en;
    for (const word of words) {
      let index;
      if (language === 'zh') {
        index = text.indexOf(word);
      } else {
        index = englishWordBoundaryMatch(text, word);
      }
      if (index < 0) continue;
      const start = codePointOffset(text, index);
      const end = start + Array.from(word).length;
      if (occupied.some(([s, e]) => start < e && end > s)) continue;
      occupied.push([start, end]);
      hits.push({ key: entry.key, term: word, span: { start, end } });
    }
  }
  return hits.sort((a, b) => a.span.start - b.span.start);
}

function detectRelation(clause, language) {
  for (const cue of ORDER_CUES) {
    const words = language === 'zh' ? cue.zh : cue.en;
    const hit = words.find((word) => clause.includes(word));
    if (hit) {
      const index = clause.indexOf(hit);
      return {
        type: cue.key,
        cue: hit,
        span: { start: codePointOffset(clause, index), end: codePointOffset(clause, index) + Array.from(hit).length }
      };
    }
  }
  const simWords = language === 'zh' ? SIMULTANEOUS_CUES.zh : SIMULTANEOUS_CUES.en;
  const sim = simWords.find((word) => clause.includes(word));
  if (sim) {
    const index = clause.indexOf(sim);
    return {
      type: 'simultaneous',
      cue: sim,
      span: { start: codePointOffset(clause, index), end: codePointOffset(clause, index) + Array.from(sim).length }
    };
  }
  return null;
}

function detectQuotes(text) {
  const quotes = [];
  const pattern = new RegExp(QUOTE_PATTERN.source, 'gu');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const contentStartUnit = match.index + 1;
    const start = codePointOffset(text, contentStartUnit);
    quotes.push({ content: match[1], span: { start, end: start + Array.from(match[1]).length } });
  }
  return quotes;
}

// 英文功能词不承载事实要素，不计入 residual。
const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'when', 'while', 'as', 'by', 'to', 'of', 'in', 'on',
  'at', 'is', 'are', 'was', 'were', 'already', 'and', 'or', 'with', 'for'
]);

/** 词表命中之外的实词片段作为 residual 概念保留，避免未登录词被静默丢弃。 */
function detectResiduals(clause, language, occupied) {
  const residuals = [];
  if (language === 'zh') {
    const pattern = /[一-鿿]{2,}/gu;
    let match;
    while ((match = pattern.exec(clause)) !== null) {
      const start = codePointOffset(clause, match.index);
      const end = start + Array.from(match[0]).length;
      if (occupied.some(([s, e]) => start < e && end > s)) continue;
      residuals.push({ key: `residual:${match[0]}`, span: { start, end } });
    }
  } else {
    const pattern = /[A-Za-z]{2,}/gu;
    let match;
    while ((match = pattern.exec(clause)) !== null) {
      const word = match[0].toLowerCase();
      if (ENGLISH_STOPWORDS.has(word)) continue;
      const start = codePointOffset(clause, match.index);
      const end = start + Array.from(match[0]).length;
      if (occupied.some(([s, e]) => start < e && end > s)) continue;
      residuals.push({ key: `residual:${word}`, span: { start, end } });
    }
  }
  return residuals;
}

/** 把一条文本切成带事实要素的主张（claim）列表。 */
export function extractClaims(text, options = {}) {
  const language = options.language ?? detectLanguage(text);
  const claims = [];
  for (const clauseInfo of splitClauses(text)) {
    const clause = clauseInfo.text;
    const concepts = detectLexicon(clause, CONCEPTS, language);
    const actions = detectLexicon(clause, ACTIONS, language);
    const relation = detectRelation(clause, language);
    const inferred = hasCue(clause, language === 'zh' ? INFERENCE_CUES.zh : INFERENCE_CUES.en);
    const correction = hasCue(clause, language === 'zh' ? CORRECTION_CUES.zh : CORRECTION_CUES.en);
    const quotes = detectQuotes(clause);
    const occupied = [
      ...concepts.map((hit) => [hit.span.start, hit.span.end]),
      ...actions.map((hit) => [hit.span.start, hit.span.end])
    ];
    const residuals = detectResiduals(clause, language, occupied);
    claims.push({
      clause,
      clauseSpan: clauseInfo.span,
      language,
      concepts: [...concepts, ...residuals].map(({ key, span }) => ({
        key,
        span,
        text: sliceByCodePoints(clause, span.start, span.end)
      })),
      actions: actions.map(({ key, span }) => ({ key, span, text: sliceByCodePoints(clause, span.start, span.end) })),
      relation,
      inferred,
      correction,
      quotes
    });
  }
  return claims;
}

function revisionRank(revision) {
  const match = /r(\d+)/u.exec(revision);
  return match ? Number(match[1]) : 0;
}

/** 找出被否定词局部作用域覆盖的动作命中（按 span，而非动作键去重）。 */
function negatedActionSpans(clause, language) {
  const spans = [];
  const cues = language === 'zh' ? NEGATION_CUES.zh : NEGATION_CUES.en;
  for (const cue of cues) {
    const cueIndex = clause.indexOf(cue);
    if (cueIndex < 0) continue;
    const cueOffset = codePointOffset(clause, cueIndex);
    let scopeEnd = Array.from(clause).length;
    const breakMatch = clause.slice(cueIndex).match(NEGATION_SCOPE_BREAK);
    if (breakMatch) {
      scopeEnd = codePointOffset(clause, cueIndex + breakMatch.index);
    }
    for (const claim of extractClaims(clause, { language })) {
      for (const action of claim.actions) {
        if (action.span.start >= cueOffset && action.span.start < scopeEnd) {
          spans.push(action.span);
        }
      }
    }
  }
  return spans;
}

/** 建立镜头索引：按 id 索引，并按 series 组织 revision 顺序。 */
export function buildShotIndex(shotRecords) {
  const byId = new Map();
  const bySeries = new Map();
  for (const record of shotRecords) {
    const shot = {
      ...record,
      clauses: splitClauses(record.text).map((clauseInfo) => ({
        ...clauseInfo,
        claims: extractClaims(clauseInfo.text, { language: record.language }),
        inferred: hasCue(clauseInfo.text, record.language === 'zh' ? INFERENCE_CUES.zh : INFERENCE_CUES.en),
        correction: hasCue(clauseInfo.text, record.language === 'zh' ? CORRECTION_CUES.zh : CORRECTION_CUES.en),
        negatedSpans: negatedActionSpans(clauseInfo.text, record.language)
      }))
    };
    byId.set(record.id, shot);
    if (!bySeries.has(record.series)) bySeries.set(record.series, []);
    bySeries.get(record.series).push(shot);
  }
  for (const shots of bySeries.values()) {
    shots.sort((a, b) => revisionRank(a.revision) - revisionRank(b.revision));
  }
  return { byId, bySeries };
}

/** 找到同一 series 中比指定镜头更晚的修订镜头。 */
function laterRevisions(index, shot) {
  const series = index.bySeries.get(shot.series) ?? [];
  return series.filter((candidate) => revisionRank(candidate.revision) > revisionRank(shot.revision));
}

/**
 * 检查某镜头中的动作主张是否已被同系列较晚修订推翻。
 * 仅当较晚修订的订正句点名了同一动作时才失效；订正不株连其他动作。
 * 返回推翻依据或 null。
 */
export function findInvalidation(index, shotId, actionKey) {
  const shot = index.byId.get(shotId);
  if (!shot) return null;
  for (const later of laterRevisions(index, shot)) {
    for (const clause of later.clauses) {
      if (!clause.correction) continue;
      const actionHit = clause.claims.some((claim) => claim.actions.some((a) => a.key === actionKey));
      if (actionHit) {
        return {
          invalidatedBy: later.id,
          revision: later.revision,
          clause: clause.text,
          span: clause.span
        };
      }
    }
  }
  return null;
}

/**
 * 判断单条主张能否被某个镜头的某个小句支持。
 * 支持条件（全部满足）：
 * 1. 镜头小句不是推断/订正句——推断不能写成镜头直接呈现的事实；
 * 2. 主张中的每个概念与动作都能在镜头小句中找到对应；
 * 3. 若主张声明先后关系，镜头小句必须保留同一关系；同时关系要求两个事件同句出现。
 */
export function supportFromClause(claim, shot, clause) {
  if (clause.inferred || clause.correction) {
    return { supported: false, reason: '该镜头片段是推断或订正，不能作为直接呈现事实的依据', clause: clause.text };
  }
  const evidenceClaims = clause.claims;
  const evidenceConcepts = new Set();
  const evidenceActions = new Set();
  const evidenceRelations = [];
  const evidenceActionKeys = [];
  for (const evidence of evidenceClaims) {
    for (const concept of evidence.concepts) evidenceConcepts.add(concept.key);
    for (const action of evidence.actions) {
      const isNegated = (clause.negatedSpans ?? []).some((span) =>
        span.start === action.span.start && span.end === action.span.end);
      if (isNegated) continue;
      evidenceActions.add(action.key);
      evidenceActionKeys.push(action.key);
    }
    if (evidence.relation) evidenceRelations.push(evidence.relation);
  }
  // 动作蕴含的概念（如“进入”蕴含“来客/室内”）同样视为镜头呈现的要素。
  for (const concept of entailedConcepts(evidenceActionKeys)) evidenceConcepts.add(concept);

  const claimActionKeys = claim.actions.map((item) => item.key);
  const claimConceptKeys = new Set([
    ...claim.concepts.map((item) => item.key),
    ...entailedConcepts(claimActionKeys)
  ]);

  const missingConcepts = [...claimConceptKeys]
    .filter((key) => [...expandConcept(key)].every((candidate) => !evidenceConcepts.has(candidate)));
  const missingActions = claimActionKeys
    .filter((key) => [...expandAction(key)].every((candidate) => !evidenceActions.has(candidate)));
  if (missingConcepts.length > 0 || missingActions.length > 0) {
    return {
      supported: false,
      reason: '镜头片段缺少主张中的要素',
      missingConcepts,
      missingActions,
      clause: clause.text
    };
  }

  if (claim.relation) {
    if (claim.relation.type === 'simultaneous') {
      if (claim.actions.length < 2) {
        return { supported: true, clause: clause.text, span: clause.span, relationKept: true };
      }
      const sameClause = evidenceActions.size >= 2;
      if (!sameClause) {
        return { supported: false, reason: '镜头未在同一片段呈现两个事件，无法支持“同时”关系', clause: clause.text };
      }
    } else {
      const kept = evidenceRelations.some((relation) => relation.type === claim.relation.type);
      if (!kept) {
        return {
          supported: false,
          reason: `改写未保留“${claim.relation.type}”这一先后关系，镜头片段中找不到对应顺序`,
          clause: clause.text
        };
      }
    }
  }

  return { supported: true, clause: clause.text, span: clause.span, relationKept: Boolean(claim.relation) };
}

/**
 * 评估描述稿的每条主张。
 * @returns 每条主张带 status（supported / unsupported / invalidated / inferred）与证据列表。
 */
export function evaluateProposal(proposal, index) {
  const basisIds = parseSourceIds(proposal.reportedBasis);
  const claims = extractClaims(proposal.text, { language: proposal.language });
  return claims.map((claim, claimIndex) => {
    const evaluations = [];
    for (const basisId of basisIds) {
      const shot = index.byId.get(basisId);
      if (!shot) {
        evaluations.push({ basis: basisId, status: 'basisMissing', reason: 'reportedBasis 指向的镜头不存在' });
        continue;
      }
      for (const clause of shot.clauses) {
        const result = supportFromClause(claim, shot, clause);
        if (result.supported) {
          // 即使本片段支持，也要检查该动作是否已被更晚修订推翻。
          const invalidations = claim.actions
            .map((action) => findInvalidation(index, basisId, action.key))
            .filter(Boolean);
          evaluations.push({
            basis: basisId,
            status: invalidations.length > 0 ? 'invalidated' : 'supported',
            span: result.span,
            clause: result.clause,
            relationKept: result.relationKept,
            invalidations
          });
        } else {
          evaluations.push({ basis: basisId, status: 'unsupported', reason: result.reason, clause: result.clause });
        }
      }
    }

    const supportedEvidence = evaluations.filter((item) => item.status === 'supported');
    const invalidatedEvidence = evaluations.filter((item) => item.status === 'invalidated');
    let status = 'unsupported';
    if (claim.inferred) status = 'inferred';
    if (supportedEvidence.length > 0) status = 'supported';
    if (invalidatedEvidence.length > 0 && supportedEvidence.length === 0) status = 'invalidated';

    return {
      claimIndex,
      clause: claim.clause,
      span: claim.clauseSpan,
      concepts: claim.concepts,
      actions: claim.actions,
      relation: claim.relation,
      quotes: claim.quotes,
      inferred: claim.inferred,
      status,
      evidence: evaluations
    };
  });
}

/** 事实指纹：用于判断两段表达是否指向同一事实（换源/对照语料时两端必须一致）。
 *  使用概念/动作的多重集（含次数）与关系，因此多出一个事实要素就会产生不同指纹，
 *  避免“不同素材各自有据的文本因文案相似而被合并”。 */
export function factFingerprint(claims) {
  const parts = [];
  for (const claim of claims) {
    const conceptCounts = new Map();
    for (const concept of claim.concepts) {
      conceptCounts.set(concept.key, (conceptCounts.get(concept.key) ?? 0) + 1);
    }
    const actionCounts = new Map();
    for (const action of claim.actions) {
      actionCounts.set(action.key, (actionCounts.get(action.key) ?? 0) + 1);
    }
    const conceptPart = [...conceptCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => `${key}#${count}`).join(',');
    const actionPart = [...actionCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, count]) => `${key}#${count}`).join(',');
    parts.push([conceptPart, actionPart, `rel:${claim.relation ? claim.relation.type : 'none'}`].join('|'));
  }
  return parts.sort().join(';;');
}

/** 两个主张集合是否表达同一事实（双向概念/动作包含且关系兼容）。 */
export function sameFact(claimsA, claimsB) {
  if (claimsA.length === 0 || claimsB.length === 0) return false;
  const fpA = factFingerprint(claimsA);
  const fpB = factFingerprint(claimsB);
  return fpA === fpB;
}

/**
 * 在全部镜头中寻找能独立支持该主张集合的替代来源。
 * 仅当另一镜头自身（不依赖被撤回素材）支持同一事实时才返回；
 * 文案相似但事实要素对不上的，不会成为替代来源。
 */
export function findAlternativeSources(claims, index, excludeIds = []) {
  const alternatives = [];
  const excluded = new Set(excludeIds);
  for (const [shotId, shot] of index.byId) {
    if (excluded.has(shotId)) continue;
    const supportedClaims = [];
    for (const claim of claims) {
      const hit = shot.clauses
        .map((clause) => ({ clause, result: supportFromClause(claim, shot, clause) }))
        .find((entry) => entry.result.supported);
      if (!hit) break;
      const invalidation = claim.actions
        .map((action) => findInvalidation(index, shotId, action.key))
        .filter(Boolean);
      if (invalidation.length > 0) break;
      supportedClaims.push({ claim, clause: hit.clause, span: hit.result.span });
    }
    if (supportedClaims.length === claims.length) {
      alternatives.push({
        shotId,
        series: shot.series,
        revision: shot.revision,
        evidence: supportedClaims.map((item) => ({ span: item.span, clause: item.clause.text }))
      });
    }
  }
  return alternatives;
}

/** 检测描述稿中逐字保留的引号内容（用于“不能逐字保留招牌”类限制）。 */
export function findVerbatimQuotes(proposalText, shotIndex) {
  const findings = [];
  for (const quote of detectQuotes(proposalText)) {
    for (const [shotId, shot] of shotIndex.byId) {
      const span = findSpan(shot.text, quote.content);
      if (span) {
        findings.push({
          content: quote.content,
          proposalSpan: quote.span,
          sourceShot: shotId,
          sourceSpan: span,
          sourceText: textAt(shot.text, span)
        });
      }
    }
  }
  return findings;
}

export { normalizeText };
