#!/usr/bin/env node
/**
 * Fail CI when tests disappear behind skips/todos.
 *
 * Vitest exits 0 with skipped tests. That is fine for local iteration, but it
 * is too easy for migration PRs to hide coverage by changing runner behavior.
 */
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Usage: node scripts/verify-vitest-report.mjs <vitest-json-report>');
  process.exit(2);
}

const maxSkipped = Number(process.env.SN_TEST_MAX_SKIPPED ?? 0);
const maxTodo = Number(process.env.SN_TEST_MAX_TODO ?? 0);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const skipped = Number(report.numPendingTests ?? 0);
const todo = Number(report.numTodoTests ?? 0);
const failures = [];

if (skipped > maxSkipped) {
  failures.push(`skipped tests ${skipped} > allowed ${maxSkipped}`);
}
if (todo > maxTodo) {
  failures.push(`todo tests ${todo} > allowed ${maxTodo}`);
}

if (failures.length > 0) {
  console.error('[verify-vitest-report] FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);

  const hidden = [];
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === 'pending' || assertion.status === 'todo' || assertion.status === 'skipped') {
        hidden.push(`${suite.name}: ${assertion.fullName ?? assertion.title}`);
      }
    }
  }
  for (const testName of hidden.slice(0, 25)) {
    console.error(`    ${testName}`);
  }
  if (hidden.length > 25) {
    console.error(`    ...and ${hidden.length - 25} more`);
  }
  process.exit(1);
}

console.log(`[verify-vitest-report] OK - ${skipped} skipped, ${todo} todo`);
