import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { parse } from 'yaml';

test('the default local mutation scope matches every CI target', () => {
  const local = JSON.parse(fs.readFileSync(new URL('../stryker.config.json', import.meta.url), 'utf8'));
  const ci = parse(fs.readFileSync(new URL('../.github/workflows/mutation.yml', import.meta.url), 'utf8'));
  const targets = ci.jobs.mutation.strategy.matrix.include.flatMap(({ files }) => files.split(','));
  assert.deepEqual(local.mutate.toSorted(), targets.toSorted());
});
