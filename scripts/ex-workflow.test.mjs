import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModel, JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';
import { proveJKExpression } from './audit-rgb-gray-ex.mjs';

function engine(ex, stateful = false, initial = 0) {
  const model = compileModel({ nodes: [{ id: 'Q0', ex }],
    initial_q: { '0': stateful && initial === 0 ? ['Q0'] : [], '1': stateful && initial === 1 ? ['Q0'] : [] },
    q_y: [{ Y0: 'Q0' }] });
  assert.deepEqual(model.nodes[0].errors, []);
  return new JKEngine(model, { historyLimit: 0 });
}
function drain(runtime) {
  const events = [];
  while (runtime.length) { assert.ok(events.length < 100); events.push(runtime.step()); }
  return events;
}

test('documented algebraic rewrites preserve all sources and every independent Boolean assignment', () => {
  const cases = [
    ['J0K(X0)J1K0', 'J0K(X0)', false],
    ['J0K(X0)K(X0)', 'J0J(X0)', false],
    ['J0K(X0)J0K(X1)', 'J0J(X0)K(X1)', false],
    ['J0K(X0)K(X1)J0K1', 'J0J(X0)J(X1)K1', false],
    ['J0K(Q0)K(X0)', 'J(Q0)K(X0)', true],
    ['J0K(Q0)K(X0)J(X1)K(Q0)', 'K(X0)J(X1)K(Q0)', true],
  ];
  for (const [beforeEx, afterEx, stateful] of cases) {
    assert.equal(proveJKExpression({ id: 'Q0', beforeEx, afterEx, stateful }).equivalent, true);
    for (const initial of [0, 1]) {
      const a = engine(beforeEx, stateful, initial), b = engine(afterEx, stateful, initial);
      for (let bits = 0; bits < 8; bits++) {
        const input = { X0: bits & 1, X1: (bits >>> 1) & 1 };
        a.send(input); b.send(input);
        const x = drain(a), y = drain(b);
        assert.equal(x.length, y.length);
        assert.deepEqual(x.map(e => ({ node: e.node, before: e.before, value: e.value, transfers: e.transfers })),
          y.map(e => ({ node: e.node, before: e.before, value: e.value, transfers: e.transfers })));
        assert.deepEqual(a.q, b.q); assert.deepEqual(a.outputs, b.outputs); assert.deepEqual(a.cache, b.cache);
      }
    }
  }
});

test('constant outputs retain fresh publications on repeated equal inputs', () => {
  const a = engine('J0K(X0)K(X0)'), b = engine('J0J(X0)');
  for (const bit of [1, 1, 0, 0]) {
    for (const runtime of [a, b]) {
      runtime.send({ X0: bit }); const events = drain(runtime);
      assert.equal(events.length, 1); assert.equal(runtime.outputs.get('Y0'), 0);
      assert.equal(events[0].transfers.filter(t => t.target === 'Y0').length, 1);
    }
  }
});

test('removing a numerically discarded source makes partial input publish prematurely', () => {
  const beforeEx = 'J0K(X0)J0K(X1)', afterEx = 'J0K(X1)';
  assert.throws(() => proveJKExpression({ id: 'Q0', beforeEx, afterEx }));
  const a = engine(beforeEx), b = engine(afterEx);
  a.send({ X1: 1 }); b.send({ X1: 1 });
  assert.equal(drain(a).length, 0); assert.equal(drain(b).length, 1);
  assert.equal(a.outputs.get('Y0'), null); assert.equal(b.outputs.get('Y0'), 1);
});

test('an initial zero does not justify removing a reset from a repeatedly executed state node', () => {
  const a = engine('J0K(X0)', true), b = engine('K(X0)', true);
  assert.equal(proveJKExpression({ id: 'Q0', beforeEx: 'J0K(X0)', afterEx: 'K(X0)', stateful: true }).equivalent, false);
  const outputs = [[], []];
  for (let round = 0; round < 2; round++) for (const [index, runtime] of [a, b].entries()) {
    runtime.send({ X0: 1 }); drain(runtime); outputs[index].push(runtime.outputs.get('Y0'));
  }
  assert.deepEqual(outputs, [[1, 1], [1, 0]]);
});

test('turning a self-referenced state node into a pure constant changes initialization activation', () => {
  const a = engine('K(Q0)', true), b = engine('J0', true);
  assert.throws(() => proveJKExpression({ id: 'Q0', beforeEx: 'K(Q0)', afterEx: 'J0', stateful: true }));
  assert.equal(a.length, 0); assert.equal(b.length, 1);
});

test('single-initialization folding is conditional on old q being zero', () => {
  const args = { id: 'Q0', beforeEx: 'J0K1', afterEx: 'K1', stateful: true };
  assert.equal(proveJKExpression(args).equivalent, false);
  assert.equal(proveJKExpression({ ...args, knownValues: { Q0: 0 } }).equivalent, true);
  assert.equal(proveJKExpression({ ...args, knownValues: { Q0: 1 } }).equivalent, false);
  const runtime = engine('K1', true);
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) runtime.reset();
    const events = drain(runtime);
    assert.equal(events.length, 1); assert.equal(events[0].before, 0); assert.equal(events[0].value, 1);
    assert.equal(runtime.length, 0);
  }
});
