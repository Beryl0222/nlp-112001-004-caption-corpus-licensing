#!/usr/bin/env node
// 命令行入口：
//   assess   评估一个订购单（默认按 requestedOn，可用 --date 指定日期）
//   proposal 单独评估一条描述稿在指定用途下的状态
//   deliver  登记一次交付（重复内容自动拦截，仅可交付状态会入账）
//   correct  按原交付标识撤回并可登记更正版本
//   audit    输出某条交付的完整更正链与当时许可快照
//
// 输出均为 UTF-8 JSON，决定码为英文、解释为中文，便于程序消费与人工审核。

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadWorkspace } from './index.js';
import { evaluateOrder, expressSameFact } from './assessment.js';
import { recordDelivery, correctDelivery, loadLedger, auditTrail, listLiveDeliveries } from './deliveries.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const dataDir = flags.data
    ? pathToFileURL(`${resolve(flags.data)}/`)
    : undefined;
  const workspace = await loadWorkspace(dataDir);
  const { orders, proposals, shotIndex, parsedLicenses } = workspace;

  switch (command) {
    case 'assess': {
      const order = orders.find((item) => item.id === rest[0]);
      if (!order) return fail(`找不到订购单 ${rest[0]}`);
      const effectiveOrder = flags.parallel ? { ...order, parallel: true } : order;
      const report = evaluateOrder({
        order: effectiveOrder,
        proposals,
        shotIndex,
        parsedLicenses,
        date: flags.date
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return undefined;
    }

    case 'proposal': {
      const [proposalId, region, use, language] = rest;
      const proposal = proposals.find((item) => item.id === proposalId);
      if (!proposal) return fail(`找不到描述稿 ${proposalId}`);
      const syntheticOrder = {
        id: `cli:${proposalId}`,
        region,
        use,
        language,
        requestedOn: flags.date ?? new Date().toISOString().slice(0, 10)
      };
      const report = evaluateOrder({
        order: syntheticOrder,
        proposals: [proposal],
        shotIndex,
        parsedLicenses,
        date: flags.date
      });
      process.stdout.write(`${JSON.stringify(report.decisions[0], null, 2)}\n`);
      return undefined;
    }

    case 'deliver': {
      const [orderId, proposalId] = rest;
      const order = orders.find((item) => item.id === orderId);
      if (!order) return fail(`找不到订购单 ${orderId}`);
      const proposal = proposals.find((item) => item.id === proposalId);
      if (!proposal) return fail(`找不到描述稿 ${proposalId}`);
      const ledgerFile = resolve(flags.ledger ?? '交付台账.json');
      const report = evaluateOrder({
        order,
        proposals: [proposal],
        shotIndex,
        parsedLicenses,
        date: flags.date
      });
      const decision = report.decisions[0];
      if (!String(decision.decision).startsWith('deliverable')) {
        process.stdout.write(`${JSON.stringify({
          refused: true,
          decision: decision.decision,
          reasons: decision.reasons
        }, null, 2)}\n`);
        process.exitCode = 2;
        return undefined;
      }
      const outcome = await recordDelivery({
        file: ledgerFile,
        orderId,
        proposal,
        decision,
        deliveredOn: flags.date ?? order.requestedOn
      });
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return undefined;
    }

    case 'correct': {
      const [deliveryId] = rest;
      if (!flags.reason) return fail('correct 需要 --reason 说明撤回原因');
      const ledgerFile = resolve(flags.ledger ?? '交付台账.json');
      let replacementProposal = null;
      let replacementDecision = null;
      if (flags.replacement) {
        replacementProposal = proposals.find((item) => item.id === flags.replacement);
        if (!replacementProposal) return fail(`找不到替代描述稿 ${flags.replacement}`);
        const ledger = await loadLedger(ledgerFile);
        const original = ledger.entries.find((entry) => entry.id === deliveryId);
        const order = orders.find((item) => item.id === original.orderId);
        const report = evaluateOrder({
          order,
          proposals: [replacementProposal],
          shotIndex,
          parsedLicenses,
          date: flags.date
        });
        replacementDecision = report.decisions[0];
      }
      const outcome = await correctDelivery({
        file: ledgerFile,
        deliveryId,
        reason: flags.reason,
        correctedOn: flags.date ?? new Date().toISOString().slice(0, 10),
        replacementProposal,
        replacementDecision
      });
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return undefined;
    }

    case 'audit': {
      const ledgerFile = resolve(flags.ledger ?? '交付台账.json');
      const ledger = await loadLedger(ledgerFile);
      if (rest[0]) {
        process.stdout.write(`${JSON.stringify(auditTrail(ledger, rest[0]), null, 2)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(listLiveDeliveries(ledger), null, 2)}\n`);
      }
      return undefined;
    }

    case 'same-fact': {
      const [idA, idB] = rest;
      const a = proposals.find((item) => item.id === idA);
      const b = proposals.find((item) => item.id === idB);
      if (!a || !b) return fail('same-fact 需要两个存在的描述稿编号');
      process.stdout.write(`${JSON.stringify({ a: idA, b: idB, sameFact: expressSameFact(a, b) }, null, 2)}\n`);
      return undefined;
    }

    default:
      return fail('用法: assess <订购id> | proposal <描述id> <地区> <用途> <语言> | deliver <订购id> <描述id> | correct <交付id> | audit [交付id] | same-fact <idA> <idB>');
  }
}

main().catch((error) => {
  fail(error.stack || error.message);
});
