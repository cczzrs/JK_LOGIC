import { compileModel, JKEngine, order, parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';

const serialize = tokens => tokens.map(t => t.source ? `${t.op}(${t.source})` : `${t.op}${t.constant}`).join('');
const sourceList = tokens => [...new Set(tokens.flatMap(t => t.source ? [t.source] : []))];
const sourceKey = tokens => sourceList(tokens).sort().join(',');
const token = (op, source) => ({ op, source, constant: null });
const constant = (op, value) => ({ op, source: null, constant: value });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (ok, message) => { if (!ok) throw new Error(`JK ex audit: ${message}`); };
const operations = nodes => nodes.reduce((sum, n) => sum + parseExpression(n.ex).length, 0);

function evaluate(tokens, values, before = 0) {
  let q = before;
  for (const t of tokens) {
    const x = t.source ? values[t.source] : t.constant;
    assert(x === 0 || x === 1, `missing Boolean value for ${t.source}`);
    q = t.op === 'J' ? q & x : q ^ x;
  }
  return q;
}

/** Universal identities only. Source references remain part of the contract. */
export function simplifyJKExpression(ex, { id, stateful = false } = {}) {
  let tokens = parseExpression(ex);
  assert(stateful || tokens[0]?.text === 'J0', 'stateless expression must start with J0');
  const originalSources = sourceList(tokens), rules = [];
  function accept(candidate, rule) {
    if (candidate.length === 0) return false;
    const present = new Set(sourceList(candidate));
    for (const source of originalSources) if (!present.has(source)) {
      // J(self) preserves the implicit state accumulator. J(source) immediately
      // after a reset preserves zero while retaining the arrival dependency.
      if (stateful && source === id) candidate.unshift(token('J', source));
      else {
        const reset = candidate.findIndex(t => t.op === 'J' && t.constant === 0);
        if (reset < 0) return false;
        candidate.splice(reset + 1, 0, token('J', source));
      }
    }
    if (!stateful && !(candidate[0]?.op === 'J' && candidate[0]?.constant === 0)) return false;
    if (candidate.length >= tokens.length || sourceKey(candidate) !== [...originalSources].sort().join(',')) return false;
    tokens = candidate; rules.push(rule); return true;
  }
  for (;;) {
    let changed = false;
    // A later J0 kills the value of its entire prefix, but not its source edges.
    const lastReset = tokens.findLastIndex(t => t.op === 'J' && t.constant === 0);
    if (lastReset > 0) changed ||= accept([constant('J', 0), ...tokens.slice(lastReset + 1)], 'reset-prefix-with-source-anchors');
    if (changed) continue;
    if (stateful && tokens[0]?.op === 'J' && tokens[0]?.constant === 0
      && tokens[1]?.op === 'K' && tokens[1]?.source === id) {
      changed ||= accept(tokens.slice(2), 'implicit-state-accumulator');
    }
    if (changed) continue;
    changed ||= accept(tokens.filter(t => !(t.op === 'J' && t.constant === 1)
      && !(t.op === 'K' && t.constant === 0)), 'constant-identities');
    if (changed) continue;
    // Adjacent XORs commute. Cancel even multiplicities, then repair any source
    // whose only occurrences were cancelled with a proven identity anchor.
    for (let i = 0; i < tokens.length && !changed; i++) if (tokens[i].op === 'K') {
      let end = i;
      while (end < tokens.length && tokens[end].op === 'K') end++;
      const parity = new Map();
      for (const t of tokens.slice(i, end)) {
        const key = t.source ?? `constant:${t.constant}`;
        const entry = parity.get(key) ?? { t, count: 0 };
        entry.count++; parity.set(key, entry);
      }
      const kept = [...parity.values()].filter(x => x.count % 2).map(x => x.t);
      changed ||= accept([...tokens.slice(0, i), ...kept, ...tokens.slice(end)], 'adjacent-xor-parity');
      i = end - 1;
    }
    if (changed) continue;
    for (let i = 1; i < tokens.length && !changed; i++) {
      const a = tokens[i - 1], b = tokens[i];
      if (a.op === 'J' && b.op === 'J' && a.source === b.source && a.constant === b.constant) {
        changed ||= accept([...tokens.slice(0, i), ...tokens.slice(i + 1)], 'and-idempotence');
      }
    }
    if (!changed) break;
  }
  return { ex: serialize(tokens), rules };
}

// These expressions are used only after the complete model guards below pass.
function invariantExpression(id, r) {
  if (id === r.bootstrap) return { ex: 'K1', rule: 'bootstrap-initial-zero-once' };
  if (id === r.clock) return { ex: `J0J(${r.core_done})K(${r.bootstrap})`, rule: 'bootstrap-published-one' };
  const merge = r.merges.indexOf(id);
  if (merge >= 0) return { ex: 'J0' + (merge ? `J(${r.tokens[merge - 1]})` : '')
    + `K(${r.frame_seed})`, rule: 'frame-seed-published-one' };
  const fuel = r.tokens.indexOf(id);
  if (fuel >= 0) return { ex: `J0J(${r.merges[fuel]})K(${r.clock})`, rule: 'control-arrivals-one' };
  if (id === r.tick) return { ex: `J0K(${r.tokens[8]})`, rule: 'last-token-published-one' };
  if (id === r.selector_wrap) return { ex: `K(${r.tick})J(${r.selector_thresholds[7]})`, rule: 'wrap-disjoint-from-last-threshold' };
  const threshold = r.selector_thresholds.indexOf(id);
  if (threshold >= 0) return { ex: `J(${r.selector_wrap})K(${r.tick})`
    + (threshold ? `J(${r.selector_thresholds[threshold - 1]})` : ''), rule: 'ordered-thermometer-transition' };
  return null;
}

function knownConstant(tokens, before, known = {}) {
  let value = before;
  for (const t of tokens) {
    const x = t.source ? known[t.source] ?? null : t.constant;
    if (t.op === 'J') value = value === 0 || x === 0 ? 0
      : value === 1 && x === 1 ? 1 : null;
    else value = value === null || x === null ? null : value ^ x;
  }
  return value;
}

/** Reject unrelated models; role labels alone cannot authorize state rewrites. */
function proveSharedContext(raw, compiled) {
  const r = raw.spec?.roles;
  assert(r && raw.spec.architecture_mode === 'shared', 'shared roles are required');
  assert(compiled.issues.length === 0 && compiled.nodes.every(n => n.errors.length === 0), 'invalid input model');
  assert(raw.nodes.length === 512 && r.storage.length === 216 && r.core.length === 168
    && r.selected_inputs.length === 24 && r.output_state.length === 72
    && r.merges.length === 9 && r.tokens.length === 9 && r.selector_thresholds.length === 8,
  'unexpected shared model dimensions');
  const byId = new Map(compiled.nodes.map(n => [n.id, n]));
  const expect = (id, sources, initial) => {
    const n = byId.get(id);
    assert(n && n.initial === initial && sourceKey(n.tokens) === [...sources].sort().join(','), `role structure ${id}`);
    return n;
  };
  r.storage.forEach((id, i) => {
    const n = expect(id, [`X${i}`], 0);
    for (const before of [0, 1]) for (const x of [0, 1]) assert(evaluate(n.tokens, { [`X${i}`]: x }, before) === x, `storage write ${id}`);
    assert(order(id, r.frame_seed) < 0, 'storage must precede frame seed');
  });
  const seed = expect(r.frame_seed, r.storage.map((_, i) => `X${i}`), 0);
  assert(knownConstant(seed.tokens, null) === 1, 'frame seed must publish one for all inputs');
  const boot = expect(r.bootstrap, [], 0);
  assert(evaluate(boot.tokens, {}, 0) === 1, 'bootstrap must publish one from reset zero');
  const done = expect(r.core_done, r.core_outputs, 0);
  assert(r.core_outputs.length === 8 && new Set(r.core_outputs).size === 8
    && r.core_outputs.every(id => r.core.includes(id)), 'eight distinct core outputs required');
  assert(knownConstant(done.tokens, null) === 1, 'core completion must publish one');
  const clock = expect(r.clock, [r.bootstrap, r.core_done], null);
  assert(knownConstant(clock.tokens, 0, { [r.bootstrap]: 1 }) === 1, 'clock value invariant');
  r.merges.forEach((id, i) => {
    const n = expect(id, [r.frame_seed, ...(i ? [r.tokens[i - 1]] : [])], null);
    assert(knownConstant(n.tokens, 0, { [r.frame_seed]: 1 }) === 1, `merge value ${id}`);
  });
  r.tokens.forEach((id, i) => {
    const n = expect(id, [r.merges[i], r.clock], 0);
    assert(knownConstant(n.tokens, null, { [r.merges[i]]: 1, [r.clock]: 1 }) === 1, `token value ${id}`);
  });
  const tick = expect(r.tick, [r.tokens[8]], null);
  assert(knownConstant(tick.tokens, 0, { [r.tokens[8]]: 1 }) === 1, 'tick value invariant');
  expect(r.selector_wrap, [r.tick, r.selector_thresholds[7]], 0);
  r.selector_thresholds.forEach((id, i) => {
    expect(id, [r.tick, r.selector_wrap, ...(i ? [r.selector_thresholds[i - 1]] : [])], 1);
    assert(order(r.selector_wrap, id) < 0, 'wrap update must precede thresholds');
    if (i) assert(order(id, r.selector_thresholds[i - 1]) < 0, 'threshold updates must descend');
  });
  r.selected_inputs.forEach((id, b) => {
    expect(id, [r.tick, ...r.selector_thresholds, ...Array.from({ length: 9 }, (_, p) => r.storage[24 * p + b])], null);
    for (const s of [r.selector_wrap, ...r.selector_thresholds]) assert(order(s, id) < 0, 'selector updates must precede reads');
  });
  const priorCore = new Set(r.selected_inputs);
  for (const id of r.core) {
    const n = byId.get(id);
    assert(n && n.initial === null && n.sources.length > 0 && n.sources.every(s => priorCore.has(s)), `stateless core DAG ${id}`);
    priorCore.add(id);
  }
  r.output_state.forEach((id, i) => {
    const p = Math.floor(i / 8);
    expect(id, [id, r.core_outputs[i % 8], ...(p < 8 ? [r.selector_thresholds[p]] : []),
      ...(p ? [r.selector_thresholds[p - 1]] : [])], 0);
    assert(order(id, r.core_done) < 0, 'outputs must update before core completion');
  });
  assert(equal(raw.q_y, r.output_state.map((id, i) => ({ [`Y${i}`]: id }))), 'output mapping changed');
  const allRoles = [r.storage, [r.frame_seed, r.bootstrap, r.clock, r.tick, r.selector_wrap, r.core_done],
    r.merges, r.tokens, r.selector_thresholds, r.selected_inputs, r.core, r.output_state].flat();
  assert(allRoles.length === 512 && new Set(allRoles).size === 512, 'roles must cover every node exactly once');

  // Independent enumeration of a closed selector-state invariant. Tick is one;
  // state q is read at execution time in the proven numeric target order.
  let selectorTransitions = 0;
  for (let p = 0; p < 9; p++) for (const oldWrap of [0, 1]) {
    const oldS = Array.from({ length: 8 }, (_, i) => Number(i < p));
    if (oldWrap & oldS[7]) continue;
    const values = { [r.tick]: 1, [r.selector_wrap]: oldWrap,
      ...Object.fromEntries(r.selector_thresholds.map((id, i) => [id, oldS[i]])) };
    const wrap = evaluate(byId.get(r.selector_wrap).tokens, values, oldWrap);
    assert(wrap === oldS[7], 'wrap transition'); values[r.selector_wrap] = wrap;
    for (let i = 7; i >= 0; i--) {
      const n = byId.get(r.selector_thresholds[i]);
      values[n.id] = evaluate(n.tokens, values, oldS[i]);
    }
    const next = r.selector_thresholds.map(id => values[id]);
    assert(next.every((x, i) => x === Number(i < (p + 1) % 9)) && !(wrap & next[7]), 'thermometer invariant closure');
    selectorTransitions++;
  }
  return { selector_transitions: selectorTransitions, bootstrap_initial_zero_once: true,
    controller_values_one: true, ordering_verified: true, sources_and_state_verified: true };
}

function minimumExpression({ ex, variables, before, valid = () => true, expected, stateful = false, expectedOps }) {
  const tokens = parseExpression(ex), sources = sourceList(tokens), rows = 2 ** variables.length;
  assert(rows <= 16, 'minimum-expression search supports at most four Boolean variables');
  const width = 2 ** rows, mask = width - 1;
  const assignments = Array.from({ length: rows }, (_, i) => Object.fromEntries(variables.map((v, bit) => [v, (i >> bit) & 1])));
  const accepted = assignments.reduce((bits, values, i) => bits + (valid(values) ? 2 ** i : 0), 0);
  const truth = Object.fromEntries(variables.map(v => [v, assignments.reduce((bits, values, i) => bits + (valid(values) && values[v] ? 2 ** i : 0), 0)]));
  let target = 0, cases = 0;
  assignments.forEach((values, i) => {
    if (!valid(values)) return;
    const initial = before ? values[before] : 0;
    const result = expected(values);
    assert(evaluate(tokens, values, initial) === result, `primitive function ${ex}`);
    if (result) target += 2 ** i;
    cases++;
  });
  const sourceMask = 2 ** sources.length - 1, size = width * (sourceMask + 1);
  const depths = new Int8Array(size).fill(-1), queue = new Int32Array(size);
  const choices = [...sources.map((s, i) => ({ value: truth[s], bit: 2 ** i })),
    { value: 0, bit: 0 }, { value: accepted, bit: 0 }];
  const start = before ? truth[before] : 0;
  depths[start] = stateful ? 0 : 1; queue[0] = start;
  if (!stateful) assert(tokens[0]?.text === 'J0', 'stateless primitive must start with J0');
  let tail = 1, minimum = null;
  for (let head = 0; head < tail; head++) {
    const current = queue[head], f = current % width, used = Math.floor(current / width);
    if (f === target && used === sourceMask) { minimum = depths[current]; break; }
    if (depths[current] >= expectedOps) continue;
    for (const x of choices) for (const op of ['J', 'K']) {
      const result = (op === 'J' ? f & x.value : f ^ x.value) & accepted & mask;
      const next = result + (used | x.bit) * width;
      if (depths[next] >= 0) continue;
      depths[next] = depths[current] + 1; queue[tail++] = next;
    }
  }
  assert(tokens.length === expectedOps && minimum === expectedOps, `primitive is not the asserted scoped minimum: ${ex}`);
  return { operations: tokens.length, minimum_operations: minimum, truth_cases: cases,
    scope: 'J/K, constants 0/1, exactly the original source set, stated state precondition' };
}

function primitiveEvents(name, raw, expected) {
  const compiled = compileModel(raw);
  assert(!compiled.issues.length && compiled.nodes.every(n => !n.errors.length), `${name} primitive structure`);
  const engine = new JKEngine(compiled, { historyLimit: 0 });
  const frames = 2 ** compiled.inputs.length + 2;
  for (let frame = 0; frame < frames; frame++) {
    const input = Object.fromEntries(compiled.inputs.map((id, i) => [id, (Math.min(frame, frames - 3) >> i) & 1]));
    engine.send(input); let count = 0;
    while (engine.length) { engine.step(); assert(++count <= raw.nodes.length, `${name} primitive termination`); }
    assert(count === raw.nodes.length, `${name} primitive event count`);
    assert(equal([...engine.outputs.values()], expected(input)), `${name} primitive outputs`);
    assert(compiled.nodes.every(n => engine.cache.get(n.key).size === 0), `${name} primitive pending arrivals`);
  }
  return { frames, executions_per_frame: raw.nodes.length, repeated_values_checked: true };
}

function fullAdderNodeLowerBound() {
  const sum = 0x96, carry = 0xe8;
  const closure = extra => {
    const seen = new Set([0]), queue = [0], values = [0, 255, 0xaa, 0xcc, 0xf0, ...extra];
    for (let i = 0; i < queue.length; i++) for (const x of values) for (const f of [queue[i] & x, queue[i] ^ x]) {
      if (!seen.has(f)) { seen.add(f); queue.push(f); }
    }
    return seen;
  };
  const inputsOnly = closure([]), withSum = closure([sum]);
  assert(inputsOnly.size === 224 && withSum.size === 224 && inputsOnly.has(sum)
    && !inputsOnly.has(carry) && !withSum.has(carry), 'full-adder two-node lower-bound search');
  return { passed: true, minimum_nodes: 3, inputs_only_reachable_functions: inputsOnly.size,
    with_sum_reachable_functions: withSum.size, carry_reachable: false,
    scope: 'Stateless nodes with sequential J/K over constants, three raw input bits and earlier node values; two distinct sum/carry outputs.' };
}

function controlSelectorEvents() {
  const nodes = [], initial_q = { '0': [], '1': [] };
  const add = (id, ex, state) => { nodes.push({ id, ex }); if (state !== undefined) initial_q[state].push(id); };
  const r = { storage: Array.from({ length: 9 }, (_, i) => `Q${i}`), frame_seed: 'Q9', bootstrap: 'Q10', clock: 'Q11',
    merges: Array.from({ length: 9 }, (_, i) => `Q${12 + i}`), tokens: Array.from({ length: 9 }, (_, i) => `Q${21 + i}`),
    tick: 'Q30', selector_wrap: 'Q31', selector_thresholds: Array.from({ length: 8 }, (_, i) => `Q${39 - i}`), core_done: 'Q51' };
  r.storage.forEach((id, i) => add(id, `J0K(X${i})`, 0));
  add(r.frame_seed, 'J0' + r.storage.map((_, i) => `J(X${i})`).join('') + 'K1', 0);
  for (const id of [r.bootstrap, r.clock, ...r.merges, ...r.tokens, r.tick, r.selector_wrap, ...[...r.selector_thresholds].reverse()]) {
    const isState = [r.bootstrap, ...r.tokens, r.selector_wrap, ...r.selector_thresholds].includes(id);
    add(id, invariantExpression(id, r).ex, isState ? Number(r.selector_thresholds.includes(id)) : undefined);
  }
  let read = `J0J(${r.tick})K(${r.storage[8]})`;
  for (let p = 7; p >= 0; p--) read += `K(${r.storage[p]})J(${r.selector_thresholds[p]})K(${r.storage[p]})`;
  add('Q40', read); add('Q41', 'J0K(Q40)');
  for (let p = 0; p < 9; p++) {
    const id = `Q${42 + p}`;
    add(id, p === 0 ? `J(${id})K(Q41)J(${r.selector_thresholds[0]})K(Q41)`
      : p === 8 ? `K(Q41)J(${r.selector_thresholds[7]})K(${id})`
        : `K(Q41)J(${r.selector_thresholds[p]})K(${id})K(Q41)J(${r.selector_thresholds[p - 1]})K(${id})`, 0);
  }
  add(r.core_done, 'J0J(Q41)K1', 0);
  const model = compileModel({ nodes, initial_q, q_y: Array.from({ length: 9 }, (_, p) => ({ [`Y${p}`]: `Q${42 + p}` })) });
  assert(!model.issues.length && model.nodes.every(n => !n.errors.length), 'control primitive structure');
  const engine = new JKEngine(model, { historyLimit: 0 });
  let startup = 0; while (engine.length) { engine.step(); assert(++startup <= 2, 'control startup termination'); }
  assert(startup === 2 && [...engine.outputs.values()].every(v => v === null), 'control primitive startup');
  let executions = 0;
  for (let frame = 0; frame < 514; frame++) {
    const bits = Math.min(frame, 511), counts = Array(9).fill(0); let rounds = 0, steps = 0;
    engine.send(Object.fromEntries(r.storage.map((_, i) => [`X${i}`, (bits >> i) & 1])));
    while (engine.length) {
      const event = engine.step(); executions++; assert(++steps < 400, 'control primitive termination');
      if (event.node === 'Q41') rounds++;
      for (const t of event.transfers) if (t.target.startsWith('Y')) counts[Number(t.target.slice(1))]++;
    }
    assert(rounds === 9 && counts.every(n => n === 9), 'control primitive publication counts');
    assert([...engine.outputs.values()].every((v, p) => v === ((bits >> p) & 1)), 'nine-way selector and output function');
    for (const n of model.nodes) {
      const cache = engine.cache.get(n.key);
      assert(r.tokens.includes(n.id) ? cache.size === 1 && cache.get(r.clock) === 1 : cache.size === 0, 'control idle cache');
    }
  }
  return { passed: true, nodes: nodes.length, frames: 514, input_patterns: 512, initialization_events: startup,
    executions, rounds_per_frame: 9, publications_per_output_per_frame: 9, repeated_values_checked: true };
}

let preflightCache, preflightKey;
/** Executed before a shared model is assembled; failed checks prevent generation. */
export function validateSharedBuildingBlocks(primitives) {
  const key = primitives === undefined ? undefined : JSON.stringify(primitives);
  if (preflightCache && (key === undefined || key === preflightKey)) return structuredClone(preflightCache);
  assert(primitives?.xor && primitives?.mux && primitives?.full_adder, 'actual Builder primitives must be supplied on first preflight');
  const checks = [];
  const add = (name, options) => checks.push({ name, ...minimumExpression(options) });
  add('xor', { ex: primitives.xor.nodes[0].ex, variables: ['X0', 'X1'], expected: v => v.X0 ^ v.X1, expectedOps: 3 });
  add('mux', { ex: primitives.mux.nodes[0].ex, variables: ['X0', 'X1', 'X2'], expected: v => v.X0 ? v.X2 : v.X1, expectedOps: 5 });
  const before = 'old_q';
  add('constant-one', { ex: 'J0J(X0)J(X1)J(X2)K1', variables: [before, 'X0', 'X1', 'X2'], before, stateful: true, expected: () => 1, expectedOps: 5 });
  add('bootstrap', { ex: 'K1', variables: [before], before, stateful: true, valid: v => v[before] === 0, expected: () => 1, expectedOps: 1 });
  add('one-source-control', { ex: 'J0K(X0)', variables: ['X0'], valid: v => v.X0 === 1, expected: () => 1, expectedOps: 2 });
  add('two-source-control', { ex: 'J0J(X0)K(X1)', variables: ['X0', 'X1'], valid: v => v.X1 === 1, expected: () => 1, expectedOps: 3 });
  add('stateful-token', { ex: 'J0J(X0)K(X1)', variables: [before, 'X0', 'X1'], before, stateful: true,
    valid: v => v.X0 === 1 && v.X1 === 1, expected: () => 1, expectedOps: 3 });
  add('selector-wrap', { ex: 'K(X0)J(X1)', variables: [before, 'X0', 'X1'], before, stateful: true,
    valid: v => v.X0 === 1 && !(v[before] & v.X1), expected: v => v.X1, expectedOps: 2 });
  add('selector-first', { ex: 'J(X1)K(X0)', variables: [before, 'X0', 'X1'], before, stateful: true,
    valid: v => v.X0 === 1 && v.X1 <= v[before], expected: v => 1 ^ v.X1, expectedOps: 2 });
  add('selector-rest', { ex: 'J(X1)K(X0)J(X2)', variables: [before, 'X0', 'X1', 'X2'], before, stateful: true,
    valid: v => v.X0 === 1 && v.X1 <= v[before], expected: v => (1 ^ v.X1) & v.X2, expectedOps: 3 });
  add('nested-read-mux-step', { ex: 'K(X0)J(X1)K(X0)', variables: [before, 'X0', 'X1'], before, stateful: true,
    expected: v => v.X0 ^ ((v[before] ^ v.X0) & v.X1), expectedOps: 3 });
  add('output-first', { ex: 'J(Q0)K(X0)J(X1)K(X0)', variables: ['Q0', 'X0', 'X1'], before: 'Q0', stateful: true,
    expected: v => v.Q0 ^ ((v.Q0 ^ v.X0) & (1 ^ v.X1)), expectedOps: 4 });
  add('output-middle', { ex: 'K(X0)J(X2)K(Q0)K(X0)J(X1)K(Q0)', variables: ['Q0', 'X0', 'X1', 'X2'], before: 'Q0', stateful: true,
    expected: v => v.Q0 ^ ((v.Q0 ^ v.X0) & v.X1 & (1 ^ v.X2)), expectedOps: 6 });
  add('output-last', { ex: 'K(X0)J(X1)K(Q0)', variables: ['Q0', 'X0', 'X1'], before: 'Q0', stateful: true,
    expected: v => v.Q0 ^ ((v.Q0 ^ v.X0) & v.X1), expectedOps: 3 });
  assert(primitives.full_adder.nodes.length === 3 && equal(primitives.full_adder.nodes.map(n => parseExpression(n.ex).length), [3, 3, 5]), 'full-adder composition length');
  const events = {
    xor: primitiveEvents('xor', primitives.xor, v => [v.X0 ^ v.X1]),
    mux: primitiveEvents('mux', primitives.mux, v => [v.X0 ? v.X2 : v.X1]),
    full_adder: primitiveEvents('full-adder', primitives.full_adder, v => [(v.X0 + v.X1 + v.X2) & 1, Number(v.X0 + v.X1 + v.X2 >= 2)]),
    control_selector_output: controlSelectorEvents(),
  };
  preflightCache = Object.freeze({ status: 'passed', passed: true, phase: 'preassembly', template_checks: checks, primitive_events: events,
    full_adder: { nodes: 3, operations: 11 }, full_adder_lower_bound: fullAdderNodeLowerBound(),
    input_selector: { operations: 27, scope: 'reset and source anchor plus eight minimum-length three-operation mux continuations; global expression minimum not claimed' },
    constraints: ['Expression minima retain exactly the original source set and the stated old-q/source preconditions.',
      'Stateful controller and selector reductions additionally require the complete model ordering and closed reachable-state proof.',
      'The 168-node arithmetic core and complete 512-node network are not claimed globally minimal.'] });
  preflightKey = key;
  return structuredClone(preflightCache);
}

function frameOperationCount(nodes, r) {
  const count = new Map(nodes.map(n => [n.id, parseExpression(n.ex).length]));
  const sums = ids => ids.reduce((sum, id) => sum + count.get(id), 0);
  return sums(r.storage) + count.get(r.frame_seed) + 9 * (count.get(r.clock) + count.get(r.tick)
    + count.get(r.selector_wrap) + sums(r.selector_thresholds) + sums(r.selected_inputs)
    + sums(r.core) + sums(r.output_state) + count.get(r.core_done))
    + r.merges.reduce((sum, id, i) => sum + (i + 1) * count.get(id), 0)
    + r.tokens.reduce((sum, id, i) => sum + (i + 1) * count.get(id), 0);
}

function compareExecution(before, after) {
  const aModel = compileModel(before), bModel = compileModel(after);
  const a = new JKEngine(aModel, { historyLimit: 0 }), b = new JKEngine(bModel, { historyLimit: 0 });
  let events = 0, outputs = 0;
  function drain() {
    let count = 0;
    while (a.length || b.length) {
      assert(a.length === b.length, 'post-build queue length differs');
      const x = a.step(), y = b.step(); events++; count++;
      assert(count <= 3000 && x.node === y.node && x.before === y.before && x.value === y.value
        && equal(x.transfers, y.transfers), 'post-build event trace differs');
      outputs += x.transfers.filter(t => t.target.startsWith('Y')).length;
    }
    for (let i = 0; i < aModel.nodes.length; i++) assert(equal([...a.cache.get(aModel.nodes[i].key)], [...b.cache.get(bModel.nodes[i].key)]), 'post-build pending arrivals differ');
    assert(equal([...a.q], [...b.q]) && equal([...a.outputs], [...b.outputs]), 'post-build state differs');
    return count;
  }
  assert(drain() === 2 && outputs === 0, 'initialization must execute twice without outputs');
  for (let frame = 0; frame < 6; frame++) {
    const bytes = Array.from({ length: 27 }, (_, i) => frame === 0 ? 0 : frame === 1 ? 255
      : frame < 4 ? 128 : (i * 73 + frame * 41) & 255);
    let count = 0;
    for (let part = 0; part < 3; part++) {
      const input = Object.fromEntries(Array.from({ length: 216 }, (_, i) => [`X${i}`, (bytes[Math.floor(i / 8)] >> (i % 8)) & 1]).filter((_, i) => i % 3 === part));
      assert(equal(a.send(input), b.send(input)), 'post-build input event differs'); count += drain();
    }
    assert(count === 2791 && outputs === (frame + 1) * 648, 'post-build frame event count');
    for (let p = 0; p < 9; p++) {
      let actual = 0; for (let bit = 0; bit < 8; bit++) actual |= b.outputs.get(`Y${8 * p + bit}`) << bit;
      assert(actual === Math.floor((77 * bytes[3 * p] + 150 * bytes[3 * p + 1] + 29 * bytes[3 * p + 2] + 128) / 256), 'post-build independent grayscale oracle');
    }
  }
  a.reset(); b.reset(); const previousOutputs = outputs;
  assert(drain() === 2 && outputs === previousOutputs, 'reset initialization differs');
  return { status: 'passed', frames: 6, resets: 1, compared_execution_events: events, output_publications: outputs };
}

/** Visit every node, apply the two proof layers, then audit the assembled model. */
export function optimizeSharedExpressions(raw) {
  assert(preflightCache?.status === 'passed', 'building-block preflight must run before model assembly');
  const original = compileModel(raw), context = proveSharedContext(raw, original), r = raw.spec.roles;
  const nodeAudits = [];
  const nodes = raw.nodes.map((n, i) => {
    const originalNode = original.nodes[i];
    const generic = simplifyJKExpression(n.ex, { id: n.id, stateful: originalNode.initial !== null });
    let ex = generic.ex, rules = [...generic.rules], proofKind = rules.length ? 'unconditional' : 'unchanged';
    const specific = invariantExpression(n.id, r);
    if (specific && parseExpression(specific.ex).length < parseExpression(ex).length) {
      ex = specific.ex; rules.push(specific.rule); proofKind = 'reachable_invariant';
    }
    const final = simplifyJKExpression(ex, { id: n.id, stateful: originalNode.initial !== null });
    ex = final.ex; rules.push(...final.rules);
    assert(sourceKey(parseExpression(ex)) === sourceKey(originalNode.tokens), `source set changed for ${n.id}`);
    assert(simplifyJKExpression(ex, { id: n.id, stateful: originalNode.initial !== null }).ex === ex, `not at generic fixed point: ${n.id}`);
    nodeAudits.push({ id: n.id, before_ex: n.ex, after_ex: ex, before_ops: originalNode.tokens.length,
      after_ops: parseExpression(ex).length, source_set_preserved: true, state_preserved: true, proof_kind: proofKind, rules });
    return { ...n, ex };
  });
  const model = structuredClone(raw); model.nodes = nodes;
  const compiled = compileModel(model), afterContext = proveSharedContext(model, compiled);
  assert(compiled.nodes.every((n, i) => n.initial === original.nodes[i].initial
    && [...n.required].sort().join(',') === [...original.nodes[i].required].sort().join(',')), 'state class or arrival slots changed');
  const postBuild = compareExecution(raw, model);
  const report = {
    status: 'passed', visited_nodes: nodes.length, changed_nodes: nodeAudits.filter(n => n.before_ex !== n.after_ex).length,
    before_operations: operations(raw.nodes), after_operations: operations(nodes),
    before_initialization_operations: parseExpression(raw.nodes.find(n => n.id === r.bootstrap).ex).length
      + parseExpression(raw.nodes.find(n => n.id === r.clock).ex).length,
    after_initialization_operations: parseExpression(nodes.find(n => n.id === r.bootstrap).ex).length
      + parseExpression(nodes.find(n => n.id === r.clock).ex).length,
    before_frame_operations: frameOperationCount(raw.nodes, r), after_frame_operations: frameOperationCount(nodes, r),
    before_context: context, after_context: afterContext, post_build: postBuild,
    building_blocks: structuredClone(preflightCache), node_audits: nodeAudits,
    scope: 'Fixed nodes, IDs, state initialization, source graph and FIFO protocol. No global network or general expression minimum claim.',
  };
  assert(report.changed_nodes === 128 && report.after_operations === 2610
    && report.after_frame_operations === 18073 && report.after_initialization_operations === 4, 'shared optimization budget drift');
  return { model, report };
}
