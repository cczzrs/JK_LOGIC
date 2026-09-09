import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateRgbGray, pixelCore } from './generate-rgb-gray.mjs';
import { generateRgbGrayShared, sharedPixelCore } from './rgb-gray-shared.mjs';
import { generate, digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';
import { parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';
import { validate, assertSeparateFiles } from './verify-rgb-gray-shared.mjs';

const createdAt = '2026-09-08T00:00:00.000Z';
const cli = fileURLToPath(new URL('./generate-rgb-gray.mjs', import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('shared core construction does not mutate the arithmetic Builder or parallel baseline', () => {
  const baselineFile = fileURLToPath(new URL('../artifacts/rgb-gray-3x3/rgb-gray-216-72.json', import.meta.url));
  const baseline = readJson(baselineFile);
  const arithmeticBefore = generate('mul', 4, 4).md5;
  const parallelBefore = generateRgbGray({ createdAt });
  assert.equal(parallelBefore.md5, baseline.md5);
  assert.equal(sharedPixelCore().nodes.length, 168);
  generateRgbGrayShared({ createdAt });
  assert.equal(pixelCore().nodes.length, 410);
  assert.equal(generate('mul', 4, 4).md5, arithmeticBefore);
  assert.equal(generateRgbGray({ createdAt }).md5, parallelBefore.md5);
  assert.deepEqual(generateRgbGray({ createdAt }).nodes, baseline.nodes);
});

test('numeric compatibility preserves every expression and reference under exact storage renaming', () => {
  const named = generateRgbGrayShared({ profile: 'pixel-suffixed', createdAt });
  const numeric = generateRgbGrayShared({ profile: 'numeric-compatibility', createdAt });
  const strip = value => value.replace(/L[1-9][RGB][0-7]$/, '');
  const remapEx = ex => parseExpression(ex).map(t => t.source ? `${t.op}(${strip(t.source)})` : `${t.op}${t.constant}`).join('');
  assert.deepEqual(named.nodes.map(n => ({ id: strip(n.id), ex: remapEx(n.ex) })), numeric.nodes);
  for (const bit of ['0', '1']) assert.deepEqual(named.initial_q[bit].map(strip), numeric.initial_q[bit]);
  for (const key of ['q_y', 'inputs', 'outputs', 'created_at']) assert.deepEqual(named[key], numeric[key]);
  assert.deepEqual(numeric.spec.storage_name_aliases,
    Object.fromEntries(named.nodes.slice(0, 216).map(n => [strip(n.id), n.id])));
  for (const model of [named, numeric]) {
    assert.equal(model.md5, digest({ nodes: model.nodes, initial_q: model.initial_q, q_y: model.q_y, spec: model.spec }));
    for (const [key, value] of Object.entries(metrics(model.nodes))) assert.equal(model[key], value);
  }
});

test('CLI architecture selection writes shared artifacts separately and preserves default parallel filenames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgb-shared-cli-'));
  try {
    const oldDirectory = join(directory, 'parallel');
    const sharedDirectory = join(directory, 'shared');
    for (const args of [[oldDirectory], ['--architecture', 'shared', sharedDirectory]]) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    }
    const old = readJson(join(oldDirectory, 'rgb-gray-216-72.json'));
    const shared = readJson(join(sharedDirectory, 'rgb-gray-216-72.shared.json'));
    const compatible = readJson(join(sharedDirectory, 'rgb-gray-216-72.shared.modelshow.json'));
    assert.equal(old.jk_bits, 4339);
    assert.equal(shared.jk_bits, 512);
    assert.equal(shared.spec.architecture_mode, 'shared');
    assert.equal(compatible.spec.id_profile, 'numeric-compatibility');
    assert.equal(shared.created_at, compatible.created_at);
    assert.equal(Object.keys(readJson(join(sharedDirectory, 'example-input.json'))).length, 216);
    assert.ok(existsSync(join(sharedDirectory, 'example-expected.json')));
    assert.equal(existsSync(join(oldDirectory, 'rgb-gray-216-72.shared.json')), false);
    assert.equal(existsSync(join(sharedDirectory, 'rgb-gray-216-72.json')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('invalid architecture and profiles fail instead of silently generating a different contract', () => {
  assert.throws(() => generateRgbGrayShared({ profile: 'unknown', createdAt }));
  const directory = mkdtempSync(join(tmpdir(), 'rgb-shared-invalid-'));
  try {
    const destination = join(directory, 'unexpected-artifacts');
    const run = spawnSync(process.execPath, [cli, '--architecture', 'typo', destination], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(existsSync(destination), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the verifier rejects loss of save barriers, finite-token gating, conditional writes and valid selector initialization', () => {
  const original = generateRgbGrayShared({ createdAt });
  assert.doesNotThrow(() => validate(original));
  const mutations = [
    raw => { raw.nodes[216].ex = parseExpression(raw.nodes[216].ex).filter(t => t.source !== 'X215').map(t => t.text).join(''); },
    raw => { raw.nodes[228].ex = 'J0K(Q218)J0K1'; },
    raw => { raw.nodes[439].ex = `J0K(${raw.spec.roles.core_outputs[0]})`; },
    raw => { const id = raw.initial_q['1'].pop(); raw.initial_q['0'].push(id); },
    raw => { raw.nodes[271].ex = 'J0K(Q271)'; },
    raw => { raw.nodes[511].ex = `J0K(${raw.spec.roles.core_outputs[0]})J0K1`; },
  ];
  for (const mutate of mutations) {
    const raw = structuredClone(original);
    mutate(raw);
    Object.assign(raw, metrics(raw.nodes));
    raw.md5 = digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec });
    assert.throws(() => validate(raw));
  }
});

test('the optimized shared model keeps all state and event sources while reducing executed work', () => {
  const baseline = readJson(fileURLToPath(new URL('../artifacts/rgb-gray-3x3-shared/baseline-ex/rgb-gray-216-72.shared.json', import.meta.url)));
  const raw = generateRgbGrayShared({ createdAt });
  const sources = ex => [...new Set(parseExpression(ex).flatMap(t => t.source ? [t.source] : []))].sort();
  assert.equal(raw.jk_bits, baseline.jk_bits);
  assert.deepEqual(raw.initial_q, baseline.initial_q);
  assert.deepEqual(raw.q_y, baseline.q_y);
  for (let i = 0; i < raw.nodes.length; i++) {
    assert.equal(raw.nodes[i].id, baseline.nodes[i].id);
    assert.deepEqual(sources(raw.nodes[i].ex), sources(baseline.nodes[i].ex));
  }
  assert.equal(raw.ex_operation_sum, 2610);
  assert.equal(raw.nodes.filter((n, i) => n.ex !== baseline.nodes[i].ex).length, 128);
  const frameCount = i => i < 217 ? 1 : i === 217 ? 0 : i >= 219 && i <= 236 ? (i < 228 ? i - 218 : i - 227) : 9;
  assert.equal(raw.nodes.reduce((sum, n, i) => sum + frameCount(i) * parseExpression(n.ex).length, 0), 18073);
  assert.equal(parseExpression(raw.nodes[217].ex).length + parseExpression(raw.nodes[218].ex).length, 4);
});

test('verification reports cannot overwrite a model through identical paths or filesystem aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgb-shared-report-'));
  try {
    const modelPath = join(directory, 'model.json');
    const original = JSON.stringify(generateRgbGrayShared({ createdAt }));
    writeFileSync(modelPath, original);
    const symlink = join(directory, 'symlink.json'), hardlink = join(directory, 'hardlink.json');
    symlinkSync(modelPath, symlink); linkSync(modelPath, hardlink);
    for (const path of [modelPath, symlink, hardlink]) assert.throws(() => assertSeparateFiles(modelPath, path));
    assert.doesNotThrow(() => assertSeparateFiles(modelPath, join(directory, 'report.json')));
    assert.equal(readFileSync(modelPath, 'utf8'), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
