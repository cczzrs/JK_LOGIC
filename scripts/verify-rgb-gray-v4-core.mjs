import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { compileModel } from '../skills/jk-network-generator/scripts/model.mjs';
import { assertSeparateFiles } from '../skills/jk-network-generator/scripts/files.mjs';
import { verifyGrayCore } from './rgb-gray-v4-core.mjs';

const filename = path.resolve(process.argv[2] ?? 'artifacts/rgb-gray-v4/rgb-gray-216-72.json');
const specFile = filename.replace(/\.json$/, '.spec.json');
const reportFile = path.resolve(process.argv[3] ?? filename.replace(/\.json$/, '.truth-table.json'));
for (const source of [filename, specFile]) assertSeparateFiles(source, reportFile);
const hash = data => createHash('sha256').update(data).digest('hex');
const bytes = fs.readFileSync(filename), specBytes = fs.readFileSync(specFile);
const raw = JSON.parse(bytes), spec = JSON.parse(specBytes), compiled = compileModel(raw);
const report = { passed: false, verifier: 'rgb-gray-v4-disk-core-v1',
  model: { md5: raw.md5, format_md5: raw.format_md5, file_sha256: hash(bytes) }, spec_sha256: hash(specBytes),
  implementation: { verifier_sha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    evaluator_sha256: hash(fs.readFileSync(new URL('./rgb-gray-v4-core.mjs', import.meta.url))) },
  scope: 'Exhaustive numeric evaluation of the actual 24-bit shared arithmetic core in this saved model. Event/state scheduling is verified separately.' };
try {
  assert.equal(spec.model.md5, raw.md5); assert.equal(spec.model.format_md5, raw.format_md5);
  assert.equal(spec.model.file_sha256, report.model.file_sha256);
  const r = spec.roles, ids = new Set(r.selected_rgb);
  assert.equal(ids.size, 24);
  const nodes = r.core.map(id => {
    const node = compiled.byId.get(id)?.[0];
    assert(node && node.initial === null && node.pro === 'q=0/1');
    assert(node.sources.every(source => ids.has(source)), `${id} is not a closed topological core`);
    ids.add(id); return { id, ex: node.ex };
  });
  assert.equal(r.gray_bits.length, 8); assert(r.gray_bits.every(q => r.core.includes(q)));
  Object.assign(report, verifyGrayCore({ nodes, inputIds: r.selected_rgb, outputs: r.gray_bits }));
} catch (error) {
  report.error = error.message; fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); throw error;
}
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, cases: report.cases, elapsed_ms: report.elapsed_ms, report: reportFile }));
