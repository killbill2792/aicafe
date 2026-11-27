import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReport } from '../../acceptance/owner-gate.mjs';

export function verifyExactRegression(report, root, file) {
  const target = resolve(root, file);
  if (report?.testResults?.length !== 1 ||
      typeof report.testResults[0].name !== 'string' ||
      resolve(root, report.testResults[0].name) !== target) {
    throw new Error('The report must contain the exact approved regression file');
  }
  return validateReport(report, [file]);
}

async function run(file) {
  const root = process.cwd();
  const path = relative(root, resolve(root, file));
  if (!path || isAbsolute(path) || path.startsWith('..') || !/\.test\.tsx?$/.test(path)) {
    throw new Error('An approved repository test file is required');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'luna-proof-'));
  const outputFile = join(scratch, 'report.json');
  try {
    const { startVitest } = await import('vitest/node');
    // Use approved runner code and a fixed configuration. Product imports
    // still resolve to the candidate whose regression is being verified.
    const context = await startVitest('test', ['./' + path], {
      root, config: false, run: true, reporters: ['json'], outputFile, maxWorkers: 2,
    }, {
      resolve: { alias: { '@': root, 'server-only': resolve(root, 'lib/testing/serverOnlyStub.ts') } },
    });
    await context.close();
    const evidence = verifyExactRegression(JSON.parse(readFileSync(outputFile, 'utf8')), root, path);
    console.log(path + ': ' + evidence.passed + ' approved regression cases passed');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run(process.argv[2]);
