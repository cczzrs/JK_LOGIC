import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';
import { validate } from './verify-rgb-gray-shared.mjs';

assert.ok(process.argv.length <= 3, 'Usage: node scripts/run-rgb-gray-shared-example.mjs [ARTIFACT_DIRECTORY]');
const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('../artifacts/rgb-gray-3x3-shared', import.meta.url)));
const readJson = name => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const modelBytes = readFileSync(join(dir, 'rgb-gray-216-72.shared.json'));
const raw = JSON.parse(modelBytes.toString('utf8'));
const { model } = validate(raw);
const engine = new JKEngine(model, { historyLimit: 0 });
const publications = new Map(model.outputs.map(o => [o.id, 0]));
let operations = 0, peak = engine.length;
function drain() {
  peak = Math.max(peak, engine.length);
  while (engine.length) {
    assert.ok(engine.total < 3000, 'Example exceeded its finite execution budget');
    const event = engine.step();
    operations += event.operations.length;
    for (const t of event.transfers) if (publications.has(t.target)) publications.set(t.target, publications.get(t.target) + 1);
    peak = Math.max(peak, engine.length);
  }
}
drain();
const startup = engine.total, startupOperations = operations;
assert.equal(startup, 2); assert.equal(startupOperations, 4);
const input = readJson('example-input.json');
assert.deepEqual(Object.keys(input).sort(), [...model.inputs].sort());
engine.send(input); drain();
const gray = Array.from({ length: 9 }, (_, p) => Array.from({ length: 8 }, (_, b) => engine.outputs.get('Y' + (8 * p + b)) * 2 ** b).reduce((a, b) => a + b, 0));
const rows = [gray.slice(0, 3), gray.slice(3, 6), gray.slice(6, 9)];
assert.deepEqual(rows, readJson('example-expected.json').grayscale_rows);
assert.equal(engine.total - startup, 2791);
assert.equal(operations - startupOperations, 18073);
assert.ok([...publications.values()].every(count => count === 9));
for (let i = 0; i < 216; i++) assert.equal(engine.q.get(raw.spec.roles.storage[i]), input['X' + i]);
const report = {
  passed: true, model_md5: raw.md5, model_created_at: raw.created_at,
  model_file_sha256: createHash('sha256').update(modelBytes).digest('hex'),
  input: 'example-input.json', grayscale_rows: rows,
  startup_executions: startup, startup_operation_executions: startupOperations,
  frame_executions: engine.total - startup, frame_operation_executions: operations - startupOperations,
  peak_queue: peak, output_publications_per_bit: 9, nodes: model.nodes.length,
  total_state_bits: engine.q.size, static_ex_operation_sum: raw.ex_operation_sum,
  verified_at: new Date().toISOString(),
};
writeFileSync(join(dir, 'example-run.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
