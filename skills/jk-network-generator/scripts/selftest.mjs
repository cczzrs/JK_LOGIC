import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Builder, generate, arithmeticSpec, specificationPath } from './generate.mjs';
import { validate, verify } from './verify.mjs';
import { validateSnapshot } from './validate.mjs';
import { createSnapshot, fingerprints, metrics, parseExpression, compileModel, order } from './model.mjs';
import { JKEngine } from './engine.mjs';
import { resolveSource } from './source.mjs';

const TIME = '2026-10-08T00:1791417600000000000';
const input = i => ({ id: 'Q' + i, ex: `J0K(X${i})` });
const rehash = raw => Object.assign(raw, metrics(raw.nodes), fingerprints(raw));
function raw(nodes, initial = ['Q0'], outputs = [nodes.at(-1).id], inputBits = 1, extra = {}) {
  return createSnapshot({ nodes, initial_q: Array.isArray(initial) ? { '0': initial, '1': [] } : initial,
    q_y: outputs.map((q, i) => ({ ['Y' + i]: q })), input_bits: inputBits, created_at: TIME, ...extra });
}
const engine = (...args) => new JKEngine(compileModel(raw(...args)));
function drain(e) {
  const events = [];
  while (e.length) { assert.ok(events.length < 10000); events.push(e.step()); }
  return events;
}
const outputValues = events => events.flatMap(e => e.transfers.filter(t => t.target.startsWith('Y')).map(t => t.value));
function example() {
  return raw([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)', pro: 'q=1' }, { id: 'Q3', ex: 'J0K(Q1)' }, { id: 'Q4', ex: 'J(Q0)K(Q2)J(Q3)' }],
    { '0': ['Q0', 'Q1'], '1': ['Q4'] }, ['Q4'], 2,
    { name: 'JK 完整快照示例', jk_bits_max: 16, FIFOS: { 'Xi.FIFO': [{ Q0: {} }, { Q0: {} }], 'Qi.FIFO': [{ Q4: { Q2: 1, Q3: 0 } }, { Q2: {} }] } });
}
function arithmetic(op, a, b, optimize = true, saved = false, options = {}) {
  const model = generate(op, a, b, optimize, saved);
  return verify(model, { spec: arithmeticSpec(model, op, a, b, saved), ...options });
}

test('strict EX grammar consumes every character; only numeric IDs are allowed', () => {
  assert.deepEqual(parseExpression('J0J1K0K1J(X0)K(Q216)').map(t => t.text), ['J0', 'J1', 'K0', 'K1', 'J(X0)', 'K(Q216)']);
  for (const ex of ['', 'J0 K(X0)', 'J0\nK(X0)', 'J0K(Q0L1R0)', 'J0K(X01)', 'J0K(Q-1)', 'J0K(Y0)', 'J0K(K(X0))', 'J0K(Q1)garbage']) assert.throws(() => parseExpression(ex));
  assert.deepEqual(['Q100', 'Q10', 'Q2', 'Q0'].sort(order), ['Q0', 'Q2', 'Q10', 'Q100']);
});

test('both fingerprints reproduce the independently published JKRD snapshot example', () => {
  const m = example();
  assert.equal(m.format_md5, '57891bd07d782ead902e6109079627e0');
  assert.equal(m.md5, '5085a0e5acaea6806c007fd3421327f7');
  assert.equal(validateSnapshot(m).passed, true);
  const explicit = structuredClone(m); explicit.nodes[0].pro = 'q=0/1';
  assert.deepEqual(fingerprints(explicit), fingerprints(m));
  assert.equal(compileModel(explicit).nodes[0].pro, 'q=0/1');
  const cosmetic = structuredClone(m); cosmetic.name = '中文名称'; cosmetic.display.show = 'other'; cosmetic.jk_bits_max = 100;
  assert.deepEqual(fingerprints(cosmetic), fingerprints(m));
  const changedQ = structuredClone(m); changedQ.initial_q = { '0': ['Q0', 'Q1', 'Q4'], '1': [] };
  assert.notEqual(fingerprints(changedQ).format_md5, m.format_md5);
  for (const edit of [x => x.FIFOS['Qi.FIFO'].reverse(), x => x.FIFOS['Xi.FIFO'].pop(), x => x.FIFOS['Qi.FIFO'][0].Q4.Q2 = 0, x => x.created_at = '2026-10-08T00:1791417600000000001']) {
    const changed = structuredClone(m); edit(changed);
    assert.equal(fingerprints(changed).format_md5, m.format_md5);
    assert.notEqual(fingerprints(changed).md5, m.md5);
  }
});

test('strict schema rejects missing and extra fields, old formats, bad metadata and timestamps', () => {
  const m = example();
  for (const key of Object.keys(m)) { const bad = structuredClone(m); delete bad[key]; assert.throws(() => compileModel(bad), undefined, key); }
  for (const edit of [
    x => x.spec = {}, x => x.hash_contract = 'old', x => x.nodes[0].propagation = 'q=1',
    x => x.initial_q.extra = [], x => x.display.extra = 1,
    x => x.format = 'jk-logic-structure-V3.1.0', x => x.nodes[0].id = 'Q0L1R0',
    x => x.nodes.reverse(), x => x.input_bits = 217, x => x.output_bits = 217,
    x => x.inputs[0].X0 = 'X1', x => x.outputs[0].Y0 = 'Q4', x => x.q_y = [{ Y1: 'Q4' }],
    x => x.jk_bits_max = 4, x => x.ex_source_sum++, x => x.ex_operation_max++, x => x.jk_bits++,
    x => x.created_at = '2026-10-08T01:1791417600000000000', x => x.created_at = '2026-10-08T00:01',
    x => x.created_at += '\n', x => x.initial_q['1'][0] = 'Q4\n',
    x => x.md5 = '0'.repeat(32), x => x.format_md5 = '0'.repeat(32),
    x => x.initial_q['0'].reverse(), x => x.initial_q['1'].push('Q0'), x => x.initial_q['0'].push('Q0'),
  ]) { const bad = structuredClone(m); edit(bad); assert.throws(() => compileModel(bad)); }
});

test('input copies, source/fanout bounds, propagation and DAG constraints are structural requirements', () => {
  const base = raw([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)K(Q1)' }], ['Q0', 'Q1'], ['Q2'], 2);
  for (const edit of [
    x => x.initial_q['0'].shift(), x => x.nodes[0].ex = 'K(X0)', x => x.nodes[0].ex = 'J0K(X1)',
    x => x.nodes[2].ex = 'J0K(X0)K(Q1)', x => x.nodes[2].ex = 'J0K1',
    x => x.nodes[2].ex = 'J0K(Q2)K(Q0)K(Q1)', x => x.nodes[2].ex = 'J0K(Q99)',
    x => x.nodes[2].ex = 'K(Q0)K(Q1)', x => x.nodes[2].pro = 'q=', x => x.nodes[2].pro = 'changed',
    x => x.nodes[2].pro = 'q=1', x => x.nodes[2].ex = 'J0K(Q0)',
  ]) { const bad = structuredClone(base); edit(bad); assert.throws(() => compileModel(rehash(bad))); }
  for (const saved of [false, true]) assert.throws(() => raw([
    input(0), { id: 'Q1', ex: 'J0K(Q0)K(Q2)' }, { id: 'Q2', ex: 'J0K(Q1)', pro: saved ? 'q=' : 'q=0/1' },
  ], saved ? ['Q0', 'Q1', 'Q2'] : ['Q0'], ['Q1']), /DAG/);
  assert.throws(() => raw([input(0), { id: 'Q1', ex: 'K(Q1)' }], ['Q0', 'Q1']), /ex_source/);
  const duplicateSource = raw([input(0), { id: 'Q1', ex: 'K(Q1)K(Q0)K(Q0)' }], ['Q0', 'Q1']);
  assert.equal(duplicateSource.ex_source_sum, 2); assert.equal(duplicateSource.ex_source_max, 1);
  assert.equal(duplicateSource.ex_operation_sum, 5);
});

test('FIFOS validation requires exact target ownership and exact stateless payload keys', () => {
  const m = example();
  for (const edit of [
    x => delete x.FIFOS['Xi.FIFO'], x => x.FIFOS.other = [], x => x.FIFOS['Xi.FIFO'] = {},
    x => x.FIFOS['Xi.FIFO'][0] = { Q2: {} }, x => x.FIFOS['Qi.FIFO'][0] = { Q0: {} },
    x => x.FIFOS['Xi.FIFO'][0] = { Q0: { X0: 1 } }, x => x.FIFOS['Qi.FIFO'][0] = { Q99: {} },
    x => x.FIFOS['Qi.FIFO'][0] = { Q4: { Q2: 1 } }, x => x.FIFOS['Qi.FIFO'][0].Q4.Q0 = 1,
    x => x.FIFOS['Qi.FIFO'][0].Q4.Q2 = true, x => x.FIFOS['Qi.FIFO'][0].Q4.Q3 = 2,
    x => x.FIFOS['Qi.FIFO'][0] = { Q4: { Q2: 1, Q3: 0 }, Q2: {} },
    x => x.FIFOS['Qi.FIFO'][0] = { node: 'Q4', values: { Q2: 1, Q3: 0 } },
  ]) { const bad = structuredClone(m); edit(bad); Object.assign(bad, fingerprints(bad)); assert.throws(() => compileModel(bad)); }
});

test('restored input tasks skip unreadable Xi without even J0; zero is readable and tasks are retained', () => {
  const e = new JKEngine(compileModel(example()));
  assert.equal(e.length, 4); assert.equal(e.q.get('Q4'), 1); assert.equal(e.outputs.get('Y0'), null);
  const events = drain(e);
  assert.deepEqual(events.map(x => [x.type, x.node]), [['skipped', 'Q0'], ['skipped', 'Q0'], ['execution', 'Q4'], ['execution', 'Q2']]);
  assert.deepEqual(outputValues(events), [0]); assert.equal(events.at(-1).published, false);
  assert.equal(e.total, 2); assert.equal(e.processed, 4);
  e.reset(); e.send({ X0: 0 });
  const copies = drain(e).filter(x => x.node === 'Q0');
  assert.equal(copies.length, 3); assert.ok(copies.every(x => x.type === 'execution' && x.value === 0));
  const savedOne = raw([input(0)], { '0': [], '1': ['Q0'] }, ['Q0'], 1, { FIFOS: { 'Xi.FIFO': [{ Q0: {} }], 'Qi.FIFO': [] } });
  const unreadable = new JKEngine(compileModel(savedOne));
  assert.equal(unreadable.step().type, 'skipped'); assert.equal(unreadable.q.get('Q0'), 1); assert.equal(unreadable.outputs.get('Y0'), null);
});

test('per-Xi tasks, numeric enqueue order and priority yield two complete ordinary executions', () => {
  const e = engine([input(0), input(1), { id: 'Q2', ex: 'K(Q0)K(Q1)' }], ['Q0', 'Q1', 'Q2'], ['Q2'], 2);
  const sent = e.send({ X1: 1, X0: 1 });
  assert.deepEqual(sent.accepted, ['X0', 'X1']); assert.equal(e.q.get('Q0'), 0);
  const events = drain(e);
  assert.deepEqual(events.map(x => x.node), ['Q0', 'Q1', 'Q2', 'Q2']);
  assert.deepEqual(events.map(x => x.queue), ['Xi.FIFO', 'Xi.FIFO', 'Qi.FIFO', 'Qi.FIFO']);
  assert.deepEqual(outputValues(events), [0, 0]);
  assert.deepEqual(events.slice(2).map(x => x.reads), [{ Q0: 1, Q1: 1 }, { Q0: 1, Q1: 1 }]);
});

test('each task reads latest Xi rather than arrival history; input tasks preempt pending ordinary tasks', () => {
  const e = engine([input(0), { id: 'Q1', ex: 'K(Q0)' }], ['Q0', 'Q1']);
  e.send({ X0: 1 }); e.send({ X0: 0 });
  assert.deepEqual(outputValues(drain(e)), [0, 0]);
  e.send({ X0: 1 }); e.send({ X0: 1 });
  assert.deepEqual(outputValues(drain(e)), [1, 0]);
  e.reset(); e.send({ X0: 1 }); e.step(); // Q1 is pending.
  e.send({ X0: 0 });
  assert.equal(e.step().node, 'Q0');
  const rest = drain(e);
  assert.deepEqual(rest.map(x => x.reads), [{ Q0: 0 }, { Q0: 0 }]);
});

test('self q is fixed before EX and never creates a self-triggered task', () => {
  const e = engine([input(0), { id: 'Q1', ex: 'K1K(Q1)K(Q0)K(Q1)' }], { '0': ['Q0'], '1': ['Q1'] });
  for (const x of [1, 0, 0]) {
    const before = e.q.get('Q1'); e.send({ X0: x }); const events = drain(e);
    assert.equal(events.length, 2); assert.equal(events[1].reads.Q1, before);
    assert.equal(events[1].value, before ^ 1 ^ x);
    assert.ok(events[1].transfers.every(t => t.target !== 'Q1'));
  }
});

test('q= updates saved state silently; readers use latest q and outputs carry the event value', () => {
  const e = engine([input(0), { id: 'Q1', ex: 'K(Q0)', pro: 'q=' }, { id: 'Q2', ex: 'J0K(Q0)K(Q1)' }], ['Q0', 'Q1'], ['Q2', 'Q2']);
  for (const [x, wanted] of [[1, 0], [1, 1], [0, 0]]) {
    e.send({ X0: x }); const events = drain(e);
    assert.deepEqual(events.map(x => x.node), ['Q0', 'Q1', 'Q2']);
    assert.equal(events[1].published, false); assert.equal(events[1].transfers.length, 0);
    assert.deepEqual(outputValues(events), [wanted, wanted]);
  }
});

test('filtered stateless arrivals do not become zero events; incomplete arrivals survive drained queues', () => {
  const e = engine([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)', pro: 'q=1' }, { id: 'Q3', ex: 'J0K(Q1)' }, { id: 'Q4', ex: 'J0K1J(Q2)J(Q3)' }], ['Q0', 'Q1'], ['Q4'], 2);
  e.send({ X0: 1, X1: 1 }); assert.deepEqual(outputValues(drain(e)), [1]);
  e.send({ X0: 0, X1: 0 }); assert.deepEqual(outputValues(drain(e)), []);
  assert.equal(e.outputs.get('Y0'), 1); assert.deepEqual([...e.cache.get('node-4')], [['Q3', 0]]);
  e.send({ X0: 1 }); assert.deepEqual(outputValues(drain(e)), [0]);
});

test('each target owns its arrival set; new groups cannot mutate old tasks or be cleared by them', () => {
  const e = engine([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)' }, { id: 'Q3', ex: 'J0K(Q1)' }, { id: 'Q4', ex: 'J0K(Q2)K(Q3)K(Q0)' }, { id: 'Q5', ex: 'J0K(Q2)J(Q3)' }], ['Q0', 'Q1'], ['Q4', 'Q5'], 2);
  e.send({ X0: 1 }); drain(e); // Q2=1 waiting at two distinct targets.
  e.send({ X0: 0 }); drain(e); // Same source overwrites each pending position.
  assert.deepEqual([...e.cache.get('node-4')], [['Q2', 0]]);
  e.send({ X1: 1 }); e.step(); e.step(); // Q3 publishes, two tasks latch (0,1).
  assert.equal(e.length, 2);
  assert.ok(Object.isFrozen(e.itemAt(0).values));
  const old = e.itemAt(0);
  e.send({ X0: 1 }); e.step(); // Updates saved Q0, cannot itself trigger mixed Q4.
  assert.equal(e.queueLength('Qi.FIFO'), 3);
  assert.deepEqual(old.values, { Q2: 0, Q3: 1 });
  const first = e.step(); assert.equal(first.node, 'Q4'); assert.deepEqual(first.reads, { Q2: 0, Q3: 1, Q0: 1 });
  e.step(); e.step(); // Q5 then Q2: starts next pending group at both targets.
  assert.deepEqual([...e.cache.get('node-4')], [['Q2', 1]]);
  assert.deepEqual([...e.cache.get('node-5')], [['Q2', 1]]);
  e.send({ X1: 0 }); assert.deepEqual(outputValues(drain(e)), [0, 0]);
});

test('restored old task leaves next-group arrivals intact and snapshot omits incomplete arrivals/Xi', () => {
  const model = raw([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)' }, { id: 'Q3', ex: 'J0K(Q1)' }, { id: 'Q4', ex: 'J0K(Q2)K(Q3)' }], ['Q0', 'Q1'], ['Q4'], 2,
    { FIFOS: { 'Xi.FIFO': [], 'Qi.FIFO': [{ Q2: {} }, { Q4: { Q2: 1, Q3: 1 } }] } });
  const e = new JKEngine(compileModel(model)); e.step();
  assert.deepEqual([...e.cache.get('node-4')], [['Q2', 0]]);
  const snapshot = e.snapshot({ created_at: TIME });
  assert.deepEqual(snapshot.FIFOS['Qi.FIFO'], [{ Q4: { Q2: 1, Q3: 1 } }]);
  e.step(); assert.deepEqual([...e.cache.get('node-4')], [['Q2', 0]]);
  const resumed = new JKEngine(compileModel(snapshot));
  assert.equal(resumed.x.size, 0); assert.ok([...resumed.cache.values()].every(c => c.size === 0));
  assert.deepEqual(outputValues(drain(resumed)), [0]);
  assert.deepEqual(resumed.snapshot({ created_at: TIME }).FIFOS, { 'Xi.FIFO': [], 'Qi.FIFO': [] });
});

test('snapshot preserves current q, ordered duplicate tasks and latched payloads at a task boundary', () => {
  const e = engine([input(0), { id: 'Q1', ex: 'K(Q0)' }], ['Q0', 'Q1']);
  e.send({ X0: 1 }); e.step(); e.send({ X0: 0 }); e.send({ X0: 0 });
  const snap = e.snapshot({ created_at: TIME });
  assert.deepEqual(snap.initial_q, { '0': ['Q1'], '1': ['Q0'] });
  assert.deepEqual(snap.FIFOS, { 'Xi.FIFO': [{ Q0: {} }, { Q0: {} }], 'Qi.FIFO': [{ Q1: {} }] });
  const resumed = new JKEngine(compileModel(JSON.parse(JSON.stringify(snap))));
  assert.deepEqual(drain(resumed).map(e => e.type), ['skipped', 'skipped', 'execution']);
  assert.equal(resumed.outputs.get('Y0'), 1); // Latest saved Q0=1, Xi wasn't saved.
  assert.equal(e.q.get('Q1'), 0); // Saving did not execute tasks.
});

test('partial send reads initialized input copies; invalid/empty/unknown submits mutate nothing', () => {
  const e = engine([input(0), input(1), { id: 'Q2', ex: 'J0K(Q0)K(Q1)' }], ['Q0', 'Q1'], ['Q2'], 2);
  for (const bad of [{}, { X0: 0, X1: true }, { X2: 1 }, { X0: '1' }]) {
    assert.throws(() => e.send(bad)); assert.equal(e.length, 0); assert.equal(e.x.size, 0);
  }
  e.send({ X0: 1 }); assert.deepEqual(outputValues(drain(e)), [1]);
  assert.equal(e.x.has('X1'), false); assert.equal(e.q.get('Q1'), 0);
});

test('q=0 filtering and repeated source references produce one event relation per source', () => {
  const e = engine([{ ...input(0), pro: 'q=0' }, { id: 'Q1', ex: 'J0K(Q0)K(Q0)' }]);
  e.send({ X0: 1 }); assert.deepEqual(outputValues(drain(e)), []);
  for (let i = 0; i < 2; i++) { e.send({ X0: 0 }); assert.deepEqual(outputValues(drain(e)), [0]); }
  assert.deepEqual([...e.counts.values()], [3, 2]);
});

test('five arithmetic generators, both optimization modes and saved outputs pass bounded exhaustive domains', () => {
  for (const op of ['mul', 'add', 'and', 'or', 'xor']) for (const [a, b] of [[1, 1], [1, 3], [3, 2], [4, 4]]) {
    for (const optimize of [true, false]) assert.equal(arithmetic(op, a, b, optimize).passed, true);
    assert.equal(arithmetic(op, a, b, true, true).passed, true);
  }
});

test('32-bit multiplication preserves all 64 result bits on explicit samples', () => {
  const report = arithmetic('mul', 32, 32, true, false, { samples: 32 });
  assert.equal(report.output_bits, 64); assert.equal(report.mode, 'sampled');
  assert.throws(() => arithmetic('add', 9, 8), /Exhaustive domain/);
});

test('Builder constants keep event dependencies, preserve unused declared ports and reject conflicting specs', () => {
  const spec = { operation: 'custom', a_bits: 1, b_bits: 1, output_bits: 1 };
  const b = new Builder(); const m = b.finish([b.xor('X0', 'X0')], spec);
  const e = new JKEngine(compileModel(m));
  for (const x of [0, 1, 1]) { e.send({ X0: x, X1: x }); assert.deepEqual(outputValues(drain(e)), [0]); }
  assert.equal(Object.hasOwn(m, 'spec'), false); assert.equal(b.specification.model_md5, m.md5);
  for (const conflict of [{ signed: true }, { bit_order: 'MSB-first' }, { input_protocol: 'interleaved' }, { a_inputs: 'X1' }, { architecture: 'other' }]) assert.throws(() => new Builder().finish(['X0'], { ...spec, ...conflict }));
  assert.throws(() => new Builder().finish(['X2'], spec)); assert.throws(() => new Builder().and(0, 'Q999'));
  assert.throws(() => new Builder().and(0, 'X0\n'));
  assert.throws(() => verify(m, { spec: b.specification }), /Unsupported independent oracle/);
});

test('function verification binds the external spec and reports incorrect output mappings', () => {
  const m = generate('add', 1, 1), spec = arithmeticSpec(m, 'add', 1, 1);
  assert.throws(() => validate(m), /separate/);
  assert.throws(() => validate(m, { ...spec, model_md5: 'old' }), /bound/);
  [m.q_y[0].Y0, m.q_y[1].Y1] = [m.q_y[1].Y1, m.q_y[0].Y0]; rehash(m);
  assert.throws(() => verify(m, { spec: arithmeticSpec(m, 'add', 1, 1) }), error => {
    assert.equal(error.report.passed, false); assert.equal(error.report.phase, 'exhaustive'); assert.ok(error.report.counterexample); return true;
  });
});

test('CLIs reread V4 files and protect both model and specification from report aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jk-v4-cli-'));
  const cli = name => fileURLToPath(new URL('./' + name + '.mjs', import.meta.url));
  const run = (name, args) => spawnSync(process.execPath, [cli(name), ...args], { encoding: 'utf8' });
  try {
    const modelPath = join(directory, 'model.json'), reportPath = join(directory, 'report.json');
    const danglingModel = join(directory, 'dangling.json');
    symlinkSync(danglingModel, specificationPath(danglingModel));
    assert.equal(run('generate', ['add', '1', '1', danglingModel]).status, 1);
    assert.equal(run('generate', ['add', '1', '1', modelPath]).status, 0);
    assert.equal(run('validate', [modelPath, reportPath]).status, 0);
    assert.equal(run('verify', [modelPath, reportPath]).status, 0);
    for (const source of [modelPath, specificationPath(modelPath)]) {
      const original = readFileSync(source, 'utf8'), symlink = source + '.symlink', hardlink = source + '.hardlink';
      symlinkSync(source, symlink); linkSync(source, hardlink);
      for (const alias of [source, symlink, hardlink]) {
        assert.equal(run('verify', [modelPath, alias]).status, 1); assert.equal(readFileSync(source, 'utf8'), original);
      }
    }
    const model = JSON.parse(readFileSync(modelPath, 'utf8'));
    model.nodes[0].ex = 'J0'; writeFileSync(modelPath, JSON.stringify(model));
    assert.equal(run('verify', [modelPath, reportPath]).status, 1);
    assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).passed, false);
    assert.equal(run('validate', [modelPath, reportPath]).status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('canonical source resolution follows project metadata and rejects a changed rule version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jk-v4-source-'));
  try {
    const root = join(directory, 'JK'), project = join(directory, 'consumer'), nested = join(project, 'nested');
    mkdirSync(root); mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'jk.config.json'), JSON.stringify({ canonical: { project: 'JK', rules: 'JKRD.md', instructions: 'AGENTS.md', index: 'README.md' }, documents: { logic: 'logic.md' } }));
    writeFileSync(join(root, 'JKRD.md'), '# JKRD V4.0.0');
    writeFileSync(join(project, 'JK_SOURCE.json'), JSON.stringify({ source: { project: 'JK', root: '../JK', config: 'jk.config.json' } }));
    assert.equal(resolveSource({ cwd: nested }).root, root);
    assert.equal(resolveSource({ root }).rules, join(root, 'JKRD.md'));
    writeFileSync(join(root, 'JKRD.md'), '# JKRD V4.0.00');
    assert.throws(() => resolveSource({ root }), /版本已变化/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
