// 显式声明的语义等价类与蕴含规则。
// 这些规则是“可解释的词表规则”，不是黑箱相似度：
// 改写（翻译/概括）只有命中这些已声明的对应关系，才视为保留了同一事实要素。

// 动作等价：翻译与概括允许的动作替换（对称）。
export const ACTION_EQUIVALENCE = {
  enter: ['arrive'],
  arrive: ['enter']
};

// 概念等价：同一对象的不同说法（对称）。
export const CONCEPT_EQUIVALENCE = {
  sideDoor: ['interior'],
  interior: ['sideDoor']
};

// 动作对概念的蕴含：进入/到达动作本身蕴含“有进入者（来客）”与“室内空间”。
export const ACTION_ENTAILS = {
  enter: ['guest', 'interior'],
  arrive: ['guest', 'interior']
};

export function expandAction(key) {
  return new Set([key, ...(ACTION_EQUIVALENCE[key] ?? [])]);
}

export function expandConcept(key) {
  return new Set([key, ...(CONCEPT_EQUIVALENCE[key] ?? [])]);
}

export function entailedConcepts(actionKeys) {
  const entailed = new Set();
  for (const key of actionKeys) {
    for (const concept of ACTION_ENTAILS[key] ?? []) entailed.add(concept);
  }
  return entailed;
}
