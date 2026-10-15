import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateRgbGrayV4 } from './rgb-gray-v4.mjs';
import { assertSeparateFiles } from '../skills/jk-network-generator/scripts/files.mjs';
import { createSnapshot } from '../skills/jk-network-generator/scripts/model.mjs';
import { verifyRgbGrayV4 } from './verify-rgb-gray-v4.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const prefix = process.argv[2] ?? root + '/artifacts/rgb-gray-v4/rgb-gray-216-72';
const reportPath = process.argv[3] ?? prefix + '.negative-tests.json';
for (const suffix of ['.json', '.spec.json']) assertSeparateFiles(prefix + suffix, reportPath);
const modelBytes = fs.readFileSync(prefix + '.json'), model = JSON.parse(modelBytes);
const specBytes = fs.readFileSync(prefix + '.spec.json'), spec = JSON.parse(specBytes);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const failures = [];
const bind = (model, specification) => {
  const bound = structuredClone(specification);
  bound.model = { md5: model.md5, format_md5: model.format_md5 };
  return bound;
};
for (const [name, change] of [
  ['output-holds-old', nodes => {
    const id = spec.roles.outputs[0][0], gray = spec.roles.gray_bits[0], sel = spec.roles.selectors[0];
    nodes[+id.slice(1)].ex = `J0J(${gray})J(${sel})K(${id})`;
  }],
  ['last-selector-inverted', nodes => { nodes[+spec.roles.selectors[8].slice(1)].ex += 'K1'; }],
  ['padding-publishes-zero', nodes => { const n = nodes[+spec.roles.padding.slice(1)]; n.ex = n.ex.replace(/K1$/, ''); }],
]) {
  const nodes = structuredClone(model.nodes); change(nodes);
  const changed = createSnapshot({ nodes, initial_q: model.initial_q, q_y: model.q_y, input_bits: 216 });
  let error;
  try { verifyRgbGrayV4(changed, bind(changed, spec), { samples: 0, edges: false }); }
  catch (e) { error = e; }
  assert(error, `${name} was not rejected`);
  failures.push({ name, rejected: true, reason: error.message, phase: error.report?.phase, mutated_model: { md5: changed.md5, format_md5: changed.format_md5 } });
}
// The shortened scheduler is generated from the same final implementation;
// verify that its unmodified output still matches the final structure first.
const fresh = generateRgbGrayV4();
assert.deepEqual(fresh.model.nodes, model.nodes);
assert.deepEqual(fresh.model.initial_q, model.initial_q);
assert.deepEqual(fresh.model.q_y, model.q_y);
const short = generateRgbGrayV4({ delayAdjustment: -1 });
let error;
try { verifyRgbGrayV4(short.model, short.spec, { samples: 0, edges: false }); }
catch (e) { error = e; }
assert(error, 'Short delay was not rejected');
failures.push({ name: 'one-delay-per-gap-removed', rejected: true, reason: error.message, phase: error.report?.phase, mutated_model: { md5: short.model.md5, format_md5: short.model.format_md5 } });
const report = {
  passed: true, verified_at: new Date().toISOString(),
  model: { md5: model.md5, format_md5: model.format_md5, file_sha256: sha(modelBytes) },
  specification_sha256: sha(specBytes),
  checker_sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  verifier_sha256: sha(fs.readFileSync(root + '/scripts/verify-rgb-gray-v4.mjs')),
  generator_sha256: sha(fs.readFileSync(root + '/scripts/rgb-gray-v4.mjs')),
  negative_cases: failures,
  boundary: 'Four targeted mutations of the final structure; not a general mutation score or whole-project regression.',
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, report: reportPath, cases: failures }));
