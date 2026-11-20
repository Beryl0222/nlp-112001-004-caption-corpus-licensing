// 统一导出：读取资料后即可完成索引、解析、评估与交付台账管理。

export { readMaterials } from '../materials.js';
export * from './source.js';
export * from './licenses.js';
export * from './coverage.js';
export * from './facts.js';
export * from './assessment.js';
export * from './deliveries.js';

import { readMaterials } from '../materials.js';
import { parseLicenses } from './licenses.js';
import { buildShotIndex } from './facts.js';

/** 一次性完成资料读取与索引构建。 */
export async function loadWorkspace(directory) {
  const tables = await readMaterials(directory);
  return {
    tables,
    shots: tables['镜头.json'],
    proposals: tables['说明提案.json'],
    licenseRecords: tables['许可.json'],
    orders: tables['订购.json'],
    shotIndex: buildShotIndex(tables['镜头.json']),
    parsedLicenses: parseLicenses(tables['许可.json'])
  };
}
