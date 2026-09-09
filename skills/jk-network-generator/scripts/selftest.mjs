import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Builder, generate, digest, metrics } from './generate.mjs';
import { validate, verify, expected } from './verify.mjs';
import { parseExpression, compileModel, JKEngine, order } from './engine.mjs';

function rehash(model) {
  Object.assign(model, metrics(model.nodes));
  model.md5 = digest({ nodes: model.nodes, initial_q: model.initial_q, q_y: model.q_y, spec: model.spec });
  return model;
}
function expression(ex, values, q = 0) {
  for (const token of parseExpression(ex)) {
    const x = token.source ? values[token.source] : token.constant;
    q = token.op === 'J' ? q & x : q ^ x;
  }
  return q;
}
function engine(nodes, initial_q = { '0': [], '1': [] }, q_y = [{ Y0: nodes.at(-1).id }]) {
  const compiled = compileModel({ nodes, initial_q, q_y });
  assert.deepEqual(compiled.issues, []);
  assert.ok(compiled.nodes.every(node => node.errors.length === 0));
  return new JKEngine(compiled);
}

test('pixel state IDs parse completely while input and output IDs remain numeric', () => {
  const sources = ['X0', 'X216', 'Q0', 'Q216', 'Q0L1R0', 'Q8L1G0', 'Q215L9B7'];
  assert.deepEqual(parseExpression('J0 ' + sources.map(s => ` K(${s})`).join('')).slice(1).map(t => t.source), sources);
  for (const id of ['Q00', 'Q01L1R0', 'Q-1L1R0', 'QiL1R0', 'Q0L0R0', 'Q0L10R0', 'Q0L1R8', 'Q0L1R00', 'Q0L1A0', 'Q0L1r0', 'Q0L1R0tail', 'X0L1R0', 'Y0']) {
    assert.throws(() => parseExpression(`J0K(${id})`), /无法解析/, id);
  }
  assert.throws(() => parseExpression('J0K(Q0L1R0)tail'), /无法解析/);
  const invalidOutput = compileModel({ nodes: [{ id: 'Q0L1R0', ex: 'J0K(X0)' }], initial_q: { '0': [], '1': [] }, q_y: [{ Y0L1R0: 'Q0L1R0' }] });
  assert.deepEqual(invalidOutput.issues, ['无效输出 ID：Y0L1R0']);
});

test('pixel ID validation applies to nodes, references and output mappings', () => {
  for (const id of ['Q01L1R0', 'Q0L0G0', 'Q0L9B8', 'Q0L1R0tail', 'X0L1R0']) {
    const compiled = compileModel({ nodes: [{ id, ex: 'J0K(X0)' }], initial_q: { '0': [], '1': [] }, q_y: [{ Y0: id }] });
    assert.ok(compiled.nodes[0].errors.some(e => e.includes('节点 ID')), id);
    assert.equal(compiled.outputs[0].error, '输出引用不存在或格式错误', id);
    assert.equal(compiled.valid.length, 0);
  }
  const missing = compileModel({ nodes: [{ id: 'Q216', ex: 'J0K(Q0L1R0)' }], initial_q: { '0': [], '1': [] }, q_y: [{ Y0: 'Q0L1R0' }] });
  assert.ok(missing.nodes[0].errors.includes('引用不存在：Q0L1R0'));
  assert.equal(missing.outputs[0].error, '输出引用不存在或格式错误');
  const duplicate = compileModel({ nodes: [{ id: 'Q0L1R0', ex: 'J0' }, { id: 'Q0L1R0', ex: 'J0K1' }], initial_q: { '0': [], '1': [] }, q_y: [{ Y0: 'Q0L1R0' }] });
  assert.equal(duplicate.valid.length, 0);
  assert.equal(duplicate.outputs[0].error, '输出依赖异常');
});

test('named state writes back, publishes equal values and maps each output on every send', () => {
  const e = engine([
    { id: 'Q0L1R0', ex: 'K(Q0L1R0)K(X0)' },
    { id: 'Q216', ex: 'J0K(Q0L1R0)' },
  ], { '0': [], '1': ['Q0L1R0'] }, [{ Y0: 'Q0L1R0' }, { Y1: 'Q216' }, { Y2: 'Q0L1R0' }]);
  assert.equal(e.q.get('Q0L1R0'), 1);
  assert.equal(e.length, 0);
  assert.deepEqual([...e.outputs.values()], [null, null, null]);
  assert.deepEqual(e.model.nodes[0].required, ['X0']);
  assert.deepEqual(e.model.nodes[1].required, []);
  let prior = 1;
  for (const bit of [0, 1, 1, 0]) {
    e.send({ X0: bit });
    assert.equal(e.length, 1);
    const saved = e.step();
    assert.equal(saved.node, 'Q0L1R0');
    assert.equal(saved.before, prior);
    assert.equal(saved.reads.Q0L1R0, prior);
    assert.equal(saved.value, bit);
    assert.equal(e.q.get('Q0L1R0'), bit);
    assert.deepEqual(saved.transfers.filter(t => t.target.startsWith('Y')).map(t => t.target), ['Y0', 'Y2']);
    assert.equal(e.length, 1);
    const copied = e.step();
    assert.equal(copied.node, 'Q216');
    assert.equal(copied.reads.Q0L1R0, bit);
    assert.equal(copied.value, bit);
    assert.deepEqual([...e.outputs.values()], [bit, bit, bit]);
    assert.equal(e.length, 0);
    assert.ok([...e.cache.values()].every(c => c.size === 0));
    prior = bit;
  }
  assert.deepEqual([...e.counts.values()], [4, 4]);
  e.reset();
  assert.equal(e.q.get('Q0L1R0'), 1);
  assert.deepEqual([...e.outputs.values()], [null, null, null]);
});

test('numeric order is preserved and same-number pixel suffixes have deterministic FIFO order', () => {
  const numeric = ['Q100', 'Q9007199254740993', 'Q10', 'Q9007199254740992', 'Q0', 'Q2'];
  assert.deepEqual(numeric.sort(order), ['Q0', 'Q2', 'Q10', 'Q100', 'Q9007199254740992', 'Q9007199254740993']);
  assert.deepEqual(['X10', 'X2', 'X0'].sort(order), ['X0', 'X2', 'X10']);
  assert.deepEqual(['Y10', 'Y2', 'Y0'].sort(order), ['Y0', 'Y2', 'Y10']);
  const ids = ['Q10', 'Q2L2R0', 'Q2L1R0', 'Q2', 'Q2L1G0', 'Q2L1B0', 'Q1L9B7'];
  const expectedIds = ['Q1L9B7', 'Q2', 'Q2L1B0', 'Q2L1G0', 'Q2L1R0', 'Q2L2R0', 'Q10'];
  const e = engine(ids.map(id => ({ id, ex: 'J0K(X0)' })), undefined, [{ Y10: 'Q2L1R0' }, { Y2: 'Q1L9B7' }]);
  assert.deepEqual(e.model.targets.get('X0').map(n => n.id), expectedIds);
  assert.deepEqual(e.model.outputs.map(o => o.id), ['Y2', 'Y10']);
  e.send({ X0: 1 });
  assert.deepEqual(Array.from({ length: e.length }, (_, i) => e.itemAt(i).node.id), expectedIds);
  while (e.length) e.step();
  assert.deepEqual([...e.outputs.values()], [1, 1]);
  const initialized = engine(ids.map(id => ({ id, ex: 'J0' })));
  assert.deepEqual(Array.from({ length: initialized.length }, (_, i) => initialized.itemAt(i).node.id), expectedIds);
});

test('documented expressions cover every local Boolean assignment', () => {
  for (const a of [0, 1]) for (const b of [0, 1]) {
    const values = { X0: a, X1: b };
    for (const [ex, y] of [
      ['J0K(X0)J(X1)', a & b], ['J0K(X0)K(X1)', a ^ b],
      ['J0K(X0)K1J(X1)K(X0)', a | b],
      ['J0K1J(X0)J(X1)K1', 1 - (a & b)],
      ['J0K1K(X0)J(X1)K1K(X0)', 1 - (a | b)],
    ]) assert.equal(expression(ex, values), y);
  }
});

test('optimized and baseline arithmetic match independent functions at unequal and minimal widths', () => {
  for (const op of ['mul', 'add', 'and', 'or', 'xor']) {
    for (const [a, b] of [[1, 1], [1, 3], [3, 2], [4, 4]]) {
      for (const optimized of [true, false]) assert.equal(verify(generate(op, a, b, optimized)).passed, true);
    }
  }
  assert.ok(generate('mul', 4, 4).nodes.length < generate('mul', 4, 4, false).nodes.length);
});

test('32-bit operands produce full 64-bit multiplication on explicit samples', () => {
  const report = verify(generate('mul', 32, 32), { samples: 32 });
  assert.equal(report.mode, 'sampled');
  assert.equal(report.output_bits, 64);
  assert.equal(report.reset_cases, 5);
  assert.equal(report.reload_cases, 5);
  assert.throws(() => verify(generate('add', 9, 8)), /Exhaustive domain/);
});

test('constant output remains input-triggered on repeated sends', () => {
  const builder = new Builder();
  const raw = builder.finish([builder.xor('X0', 'X0')], { operation: 'xor', a_bits: 1, b_bits: 1, output_bits: 1 });
  const e = new JKEngine(compileModel(raw));
  for (const bit of [0, 1, 1, 0]) {
    const before = e.total;
    e.send({ X0: bit });
    while (e.length) e.step();
    assert.equal(e.total - before, 1);
    assert.equal(e.outputs.get('Y0'), 0);
  }
});

test('validation rejects tampering, invalid syntax, missing activation and wrong output mapping', () => {
  let model = generate('mul', 2, 2);
  model.nodes[0].ex += 'K1';
  assert.throws(() => validate(model), /metadata|MD5/);
  model = generate('mul', 2, 2);
  model.nodes[0].ex = 'J0K(X0)garbage';
  assert.throws(() => validate(model), /Invalid nodes/);
  model = generate('mul', 2, 2);
  model.nodes[0].ex = 'J0K(Q0)';
  model.spec.architecture = 'custom feedback network';
  assert.throws(() => verify(rehash(model)), /freshly published|Nonterminating/);
  model = generate('mul', 2, 2);
  model.nodes[0].ex = 'J0';
  assert.throws(() => validate(rehash(model)), /constant/);
  assert.equal(verify(generate('mul', 3, 3, true, true)).stateful_nodes, 6);
  model = generate('mul', 2, 2);
  model.q_y.reverse();
  model.q_y = model.q_y.map((mapping, i) => ({ ['Y' + i]: Object.values(mapping)[0] }));
  assert.throws(() => verify(rehash(model)), /Counterexample/);
});

test('Builder rejects conflicting specifications and malformed signals instead of relabeling them', () => {
  const spec = { operation: 'xor', a_bits: 1, b_bits: 1, output_bits: 1 };
  for (const conflict of [
    { signed: true }, { bit_order: 'MSB-first' }, { input_protocol: 'arbitrary interleaving' },
    { a_inputs: 'X1' }, { architecture: 'state machine' }, { output_encoding: 'signed binary' },
  ]) {
    assert.throws(() => new Builder().finish(['X0'], { ...spec, ...conflict }));
  }
  assert.throws(() => new Builder().finish(['X0'], { ...spec, output_bits: 2 }));
  assert.throws(() => new Builder().finish(['X2'], spec));
  assert.throws(() => new Builder().finish([2], spec));
  assert.throws(() => new Builder().and(0, 'Q999'));
  assert.throws(() => new Builder().xor(2, 2));
  assert.throws(() => expected('unknown', 1n, 1n));
  const model = generate('xor', 1, 1);
  model.spec.input_protocol = 'arbitrary interleaving';
  assert.throws(() => validate(rehash(model)));
});

test('state-only feedback is stopped by the verification budget and reported as a failed trajectory', () => {
  const model = generate('xor', 1, 1);
  model.nodes.push({ id: 'Q1', ex: 'K(Q1)K(Q0)' });
  model.initial_q = { '0': ['Q0', 'Q1'], '1': [] };
  model.q_y = [{ Y0: 'Q1' }];
  model.spec.architecture = 'custom state feedback';
  assert.throws(() => verify(rehash(model)), error => {
    assert.match(error.message, /Nonterminating\/repeated execution/);
    assert.equal(error.report.passed, false);
    assert.equal(error.report.phase, 'exhaustive');
    assert.equal(error.report.counterexample.a, '0');
    assert.ok(error.report.executions >= 1000);
    return true;
  });
});

test('queued arrivals are immutable while state sources are read when execution starts', () => {
  const e = engine([
    { id: 'Q0', ex: 'K(X1)' },
    { id: 'Q1', ex: 'J0K(X0)K(Q0)' },
  ], { '0': [], '1': ['Q0'] });
  assert.equal(e.outputs.get('Y0'), null);
  assert.equal(e.length, 0); // Initial q is stored, not published.
  e.send({ X1: 1 });
  e.send({ X0: 0 });
  e.send({ X0: 1 });
  assert.deepEqual([0, 1, 2].map(i => e.itemAt(i).node.id), ['Q0', 'Q1', 'Q1']);
  assert.ok(Object.isFrozen(e.itemAt(1).values));
  assert.equal(e.itemAt(1).values.X0, 0);
  assert.equal(e.itemAt(2).values.X0, 1);
  assert.equal(e.step().value, 0); // Q0 changes after Q1 was enqueued.
  assert.equal(e.step().value, 0); // Old X0 snapshot, new Q0.
  assert.equal(e.step().value, 1); // Second snapshot is not merged with the first.
  assert.equal(e.length, 0);
});

test('partial arrivals retain latest values and repeated references need only one source event', () => {
  const e = engine([{ id: 'Q0', ex: 'J0K(X0)K(X1)' }]);
  e.send({ X0: 0 });
  e.send({ X0: 1 });
  assert.equal(e.length, 0);
  e.send({ X1: 1 });
  assert.equal(e.length, 1);
  assert.equal(e.step().value, 0);
  assert.ok([...e.cache.values()].every(cache => cache.size === 0));
  const repeated = engine([{ id: 'Q0', ex: 'J0K(X0)K(X0)' }]);
  for (let i = 0; i < 2; i++) {
    repeated.send({ X0: 1 });
    assert.equal(repeated.length, 1);
    assert.equal(repeated.step().value, 0);
  }
  assert.equal(repeated.total, 2);
});

test('initial_q determines state category even when ex begins with J0; invalid sends are atomic', () => {
  const e = engine([
    { id: 'Q0', ex: 'J0K(X0)' }, { id: 'Q1', ex: 'J0K(Q0)K(X1)' },
  ], { '0': [], '1': ['Q0'] });
  assert.equal(e.q.get('Q0'), 1);
  assert.deepEqual(e.model.nodes[1].required, ['X1']);
  assert.throws(() => e.send({ X0: 0, X1: true }));
  assert.equal(e.length, 0);
  assert.equal(e.latest.size, 0);
  assert.ok([...e.cache.values()].every(cache => cache.size === 0));
});

test('CLI writes failure evidence and never replaces the model through a report alias', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jk-skill-test-'));
  const cli = fileURLToPath(new URL('./verify.mjs', import.meta.url));
  try {
    const input = join(directory, 'model.json');
    const reportFile = join(directory, 'report.json');
    const model = generate('add', 1, 1);
    [model.q_y[0].Y0, model.q_y[1].Y1] = [model.q_y[1].Y1, model.q_y[0].Y0];
    writeFileSync(input, JSON.stringify(rehash(model)));
    writeFileSync(reportFile, JSON.stringify({ passed: true }));
    const failure = spawnSync(process.execPath, [cli, input, reportFile], { encoding: 'utf8' });
    assert.equal(failure.status, 1);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.model_md5, model.md5);
    assert.ok(report.counterexample);
    const original = readFileSync(input, 'utf8');
    const symlink = join(directory, 'symlink.json');
    const hardlink = join(directory, 'hardlink.json');
    symlinkSync(input, symlink);
    linkSync(input, hardlink);
    for (const alias of [input, symlink, hardlink]) {
      assert.equal(spawnSync(process.execPath, [cli, input, alias]).status, 1);
      assert.equal(readFileSync(input, 'utf8'), original);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
