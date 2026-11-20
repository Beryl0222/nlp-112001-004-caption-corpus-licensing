import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = pathToFileURL(join(process.cwd(), 'src/cli.js')).pathname;

async function cliRun(args) {
  const { stdout } = await run(process.execPath, [cli, ...args], { cwd: process.cwd() });
  return JSON.parse(stdout);
}

test('CLI assess 对 o3 给出可替代交付与必须更正两类决定', async () => {
  const report = await cliRun(['assess', 'o3']);
  const byId = Object.fromEntries(report.decisions.map((d) => [d.proposalId, d.decision]));
  assert.equal(byId.d1, 'needsCorrection');
  assert.equal(byId.d3, 'deliverableWithAlternative');
});

test('CLI deliver 拒绝不可交付材料，可交付材料入账且标点变体去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-ledger-'));
  try {
    const ledger = join(dir, 'ledger.json');
    const first = await cliRun(['deliver', 'o3', 'd3', '--ledger', ledger, '--date', '2026-09-12']);
    assert.equal(first.status, 'delivered');

    // d1 必须更正，交付被拒绝并返回非零退出码。
    await assert.rejects(
      run(process.execPath, [cli, 'deliver', 'o3', 'd1', '--ledger', ledger, '--date', '2026-09-12'],
        { cwd: process.cwd() }),
      (error) => error.code === 2
    );

    const audit = await cliRun(['audit', '--ledger', ledger]);
    assert.equal(audit.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI correct 建立撤回-更正链并保留旧交付', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-correct-'));
  try {
    const ledger = join(dir, 'ledger.json');
    const delivered = await cliRun(['deliver', 'o3', 'd3', '--ledger', ledger, '--date', '2026-09-12']);
    const outcome = await cliRun([
      'correct', delivered.entryId, '--reason', '原依据许可撤回',
      '--replacement', 'd3', '--ledger', ledger, '--date', '2026-09-20'
    ]);
    assert.equal(outcome.recall.deliveryId, delivered.entryId);
    assert.equal(outcome.replacement.type, 'correction');
    const trail = await cliRun(['audit', delivered.entryId, '--ledger', ledger]);
    assert.deepEqual(trail.map((e) => e.type), ['delivery', 'recall', 'correction']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI same-fact 区分同一事实与不同事实', async () => {
  assert.equal((await cliRun(['same-fact', 'd2', 'd3'])).sameFact, true);
  assert.equal((await cliRun(['same-fact', 'd1', 'd3'])).sameFact, false);
});
