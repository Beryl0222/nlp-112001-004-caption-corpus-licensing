// 来源标识、文本范围与规范化工具。
// 所有 span 使用 Unicode 码点偏移（code point offset），与字符的直观顺序一致，
// 避免把代理对算成两个位置。

/** 从 reportedBasis 等字段中按出现顺序提取来源标识，忽略顿号、逗号等分隔符。 */
export function parseSourceIds(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const ids = [];
  const pattern = /[A-Za-z0-9]+/gu;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    ids.push(match[0]);
  }
  return ids;
}

/** 码点安全的切片：start/end 均为码点偏移，end 不包含。 */
export function sliceByCodePoints(text, start, end) {
  return Array.from(text).slice(start, end).join('');
}

/** 把 JS 字符串索引转成码点偏移。 */
export function codePointOffset(text, index) {
  let offset = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code > 0xffff) i += 1;
    offset += 1;
  }
  return offset;
}

/** 按中文句读（。！？；以及换行）切分小句，保留每句在原文中的码点范围。 */
export function splitClauses(text) {
  const clauses = [];
  const pattern = /[^。！？!?；;\n]+[。！？!?；;]?/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const start = codePointOffset(text, match.index);
    clauses.push({
      text: raw,
      span: { start, end: start + Array.from(raw).length }
    });
  }
  return clauses;
}

/** 用于指纹比对的规范化：去掉所有空白与标点差异，只保留字母、数字与 CJK 字符。 */
export function normalizeText(text) {
  return Array.from(String(text))
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join('')
    .toLowerCase();
}

/** 找到 needle 在 haystack 中的码点范围；不存在返回 null。 */
export function findSpan(haystack, needle) {
  const unitIndex = haystack.indexOf(needle);
  if (unitIndex < 0) return null;
  const start = codePointOffset(haystack, unitIndex);
  return { start, end: start + Array.from(needle).length };
}

/** 码点范围转回实际文本。 */
export function textAt(text, span) {
  return sliceByCodePoints(text, span.start, span.end);
}
