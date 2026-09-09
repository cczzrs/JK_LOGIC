import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModel, order, parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';

const SELF_FILE = fileURLToPath(import.meta.url);
const ENGINE_FILE = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
// Engine dispatch ordering deliberately ignores the X/Q prefix. Set identities
// still need a total order when, for example, X0 and Q0 are both present.
const sourceOrder = (a, b) => order(a, b) || (a < b ? -1 : a > b ? 1 : 0);
const sourcesOf = tokens => [...new Set(tokens.flatMap(token => token.source ? [token.source] : []))].sort(sourceOrder);
const exOf = tokens => tokens.map(token => token.source ? `${token.op}(${token.source})` : `${token.op}${token.constant}`).join('');
const sorted = ids => [...ids].sort(sourceOrder);

// Exact Boolean algebra over GF(2), with x*x=x. A monomial is its sorted set of
// variable names; the empty monomial is 1. This handles the 216-input barrier
// symbolically, without treating random samples as an equivalence proof.
function anf(tokens, id, stateful, knownValues = {}) {
  for (const value of Object.values(knownValues)) assert.ok(value === 0 || value === 1, 'Known values must be Boolean');
  const variable = name => Object.hasOwn(knownValues, name) ? knownValues[name] : name;
  const initial = stateful ? variable(id) : 0;
  let polynomial = new Set(initial === 0 ? [] : [initial === 1 ? '' : initial]);
  const toggle = (set, term) => set.has(term) ? set.delete(term) : set.add(term);
  for (const token of tokens) {
    const input = token.source ? variable(token.source) : token.constant;
    if (token.op === 'K') {
      if (input !== 0) toggle(polynomial, input === 1 ? '' : input);
    } else if (input === 0) polynomial = new Set();
    else if (input !== 1) {
      const product = new Set();
      for (const monomial of polynomial) {
        const term = [...new Set([...(monomial ? monomial.split('&') : []), input])].sort().join('&');
        toggle(product, term);
      }
      polynomial = product;
    }
  }
  return [...polynomial].sort();
}

/** Independent helper usable before a primitive is copied into a larger graph. */
export function proveJKExpression({ id, beforeEx, afterEx = beforeEx, stateful = false, knownValues = {} }) {
  const before = parseExpression(beforeEx), after = parseExpression(afterEx);
  assert.deepEqual(sourcesOf(after), sourcesOf(before), `${id}: rewrite changes the unique source set`);
  if (!stateful) assert.equal(after[0].text, 'J0', `${id}: stateless expression must retain initial J0`);
  const beforeAnf = anf(before, id, stateful, knownValues), afterAnf = anf(after, id, stateful, knownValues);
  return {
    equivalent: canonical(beforeAnf) === canonical(afterAnf),
    method: Object.keys(knownValues).length ? 'exact ANF under explicitly supplied source/state values' : 'exact unconditional ANF',
    known_values: knownValues,
    sources: sourcesOf(before),
    before_operations: before.length, after_operations: after.length,
    before_anf: beforeAnf, after_anf: afterAnf,
  };
}

const searchCache = new Map();
function exactSmallSearch(variableCount, startingVariable = -1) {
  const cacheKey = `${variableCount}:${startingVariable}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);
  assert.ok(variableCount >= 1 && variableCount <= 4, 'Exact local BFS supports one through four named sources');
  const rows = 2 ** variableCount, full = 2 ** rows - 1, stride = 1 << variableCount;
  const masks = Array.from({ length: variableCount }, (_, bit) => {
    let mask = 0;
    for (let row = 0; row < rows; row++) if (row & (1 << bit)) mask |= 1 << row;
    return mask;
  });
  const size = (2 ** rows) * stride, distance = new Int16Array(size).fill(-1);
  const previous = new Int32Array(size).fill(-1), via = new Int8Array(size).fill(-1), queue = new Int32Array(size);
  const operations = masks.flatMap((_, index) => [{ op: 'J', index }, { op: 'K', index }]);
  operations.push({ op: 'J', index: -1 }, { op: 'K', index: -2 });
  // J1/K0 are identities, do not introduce a source and cannot shorten a path.
  const start = (startingVariable < 0 ? 0 : masks[startingVariable]) * stride;
  let end = 0;
  queue[end++] = start; distance[start] = 0;
  for (let head = 0; head < end; head++) {
    const key = queue[head], value = Math.floor(key / stride), used = key % stride;
    for (let index = 0; index < operations.length; index++) {
      const op = operations[index], input = op.index >= 0 ? masks[op.index] : op.index === -1 ? 0 : full;
      const nextValue = op.op === 'J' ? value & input : value ^ input;
      const nextUsed = op.index >= 0 ? used | (1 << op.index) : used;
      const next = nextValue * stride + nextUsed;
      if (distance[next] !== -1) continue;
      distance[next] = distance[key] + 1; previous[next] = key; via[next] = index; queue[end++] = next;
    }
  }
  const search = {
    full, masks, explored_states: end,
    shortest(target, names) {
      let key = target * stride + stride - 1;
      assert.ok(distance[key] >= 0, 'Truth function is unreachable with all declared sources');
      const result = [];
      while (key !== start) {
        const operation = operations[via[key]];
        result.push(operation.index >= 0 ? `${operation.op}(${names[operation.index]})` : operation.index === -1 ? 'J0' : 'K1');
        key = previous[key];
      }
      return result.reverse();
    },
  };
  searchCache.set(cacheKey, search);
  return search;
}

function localMinimum(node) {
  const sources = sourcesOf(node.tokens), selfIndex = sources.indexOf(node.id);
  if (sources.length >= 1 && sources.length <= 4 && (node.initial === null || selfIndex >= 0)) {
    const search = exactSmallSearch(sources.length, node.initial === null ? -1 : selfIndex);
    let value = node.initial === null ? 0 : search.masks[selfIndex];
    for (const token of node.tokens) {
      const input = token.source ? search.masks[sources.indexOf(token.source)] : token.constant === 1 ? search.full : 0;
      value = token.op === 'J' ? value & input : value ^ input;
    }
    const expression = [...(node.initial === null ? ['J0'] : []), ...search.shortest(value, sources)];
    return {
      status: expression.length === node.tokens.length ? 'minimum_in_declared_local_class' : 'shorter_unconditional_expression_found',
      proof: 'Exhaustive BFS of Boolean truth functions and used-source masks; all original sources must remain referenced',
      independent_sources: sources.length, explored_states: search.explored_states,
      minimum_operations: expression.length, shortest_expression: expression.join(''),
    };
  }
  if (node.initial === null && node.tokens.length === sources.length + 1) return {
    status: 'minimum_in_declared_local_class', proof: 'One mandatory initial J0 plus one occurrence of every required original source',
    minimum_operations: node.tokens.length,
  };
  if (node.initial === null && node.tokens.slice(1).every(token => token.op === 'K') &&
      node.tokens.filter(token => token.text === 'K1').length === 1 && node.tokens.length === sources.length + 2) return {
    status: 'minimum_in_declared_local_class',
    proof: 'All sources must occur, stateless J0 is mandatory, and the all-zero source assignment requires a separate K1',
    minimum_operations: node.tokens.length,
  };
  const hits = [];
  for (let i = 0; i < node.tokens.length; i++) {
    if (['J1', 'K0'].includes(node.tokens[i].text)) hits.push({ rule: 'identity_constant', token: i });
    if (i > 0 && node.tokens[i].op === node.tokens[i - 1].op && node.tokens[i].source &&
        node.tokens[i].source === node.tokens[i - 1].source) hits.push({ rule: 'adjacent_repeated_source', token: i });
  }
  for (let i = 1; i < node.tokens.length;) {
    let end = i + 1;
    while (end < node.tokens.length && node.tokens[end].op === node.tokens[i].op) end++;
    const seen = new Set();
    for (let j = i; j < end; j++) {
      const token = node.tokens[j], key = token.source ?? String(token.constant);
      if (seen.has(key)) hits.push({ rule: 'repetition_inside_commuting_run', token: j });
      seen.add(key);
    }
    i = end;
  }
  return {
    status: 'checked_minimum_not_proven',
    checked_rules: ['J1/K0', 'adjacent K cancellation', 'repeated J absorption', 'commuting-run repetitions', 'mandatory-source lower bound', 'reset and XOR/AND inlining shapes'],
    applicable_local_patterns: hits,
    boundary: 'No unproved rewrite is applied. This is not a shortest-expression certificate for arbitrary larger functions or correlated graph sources.',
  };
}

/** Small blocks can call this before reuse; truth/oracle and FIFO tests remain separate obligations. */
export function auditPrimitiveExpressions({ name, nodes, initial_q = { '0': [], '1': [] } }) {
  const states = new Map([...initial_q['0'].map(id => [id, 0]), ...initial_q['1'].map(id => [id, 1])]);
  const audits = nodes.map(node => {
    const tokens = parseExpression(node.ex), initial = states.has(node.id) ? states.get(node.id) : null;
    if (initial === null) assert.equal(tokens[0].text, 'J0');
    const sources = sourcesOf(tokens);
    return { id: node.id, initial, operations: tokens.length, sources,
      required_interface_sources: sources.filter(id => !states.has(id)),
      local_minimum: localMinimum({ ...node, tokens, initial }) };
  });
  return {
    name, nodes: audits.length, operations: audits.reduce((sum, node) => sum + node.operations, 0), node_audits: audits,
    boundary: 'Per-expression minimum uses the fixed original source interface, arbitrary independent input bits, and no new nodes. It does not establish minimum block node count, safe graph rewiring, or FIFO equivalence. External persistent source classification must be supplied in initial_q.',
  };
}

export function proveFullAdderNodeLowerBound() {
  const a = 0xaa, b = 0xcc, c = 0xf0, sum = 0x96, carry = 0xe8;
  function closure(sources) {
    const seen = new Set([0]), queue = [0];
    for (let head = 0; head < queue.length; head++) for (const source of [...sources, 0, 255]) {
      for (const next of [queue[head] & source, queue[head] ^ source]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen;
  }
  const first = closure([a, b, c]), afterSum = closure([a, b, c, sum]);
  assert.equal(first.size, 224); assert.equal(afterSum.size, 224);
  assert.ok(!first.has(carry) && !afterSum.has(carry));
  return {
    proof: 'Complete eight-row Boolean-function closure under every legal sequential J/K source or constant operation',
    first_node_reachable_functions: first.size, after_sum_node_reachable_functions: afterSum.size,
    carry_reachable_as_first_node: false, carry_reachable_with_sum_as_extra_source: false,
    minimum_nodes_for_two_separate_sum_carry_publications: 3,
    boundary: 'Stateless flat-ex full adder with independent a,b,c, two separate outputs, original inputs/constants and earlier computed nodes as sources. This does not establish a minimum for the whole grayscale network.',
  };
}

function loadRawModel(raw) {
  const compiled = compileModel(raw);
  assert.equal(compiled.issues.length, 0, 'Invalid model structure');
  assert.ok(compiled.nodes.every(node => !node.errors.length), 'Invalid model nodes');
  const md5 = createHash('md5').update(canonical({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec })).digest('hex');
  assert.equal(raw.md5, md5, 'Model MD5 mismatch');
  assert.ok(typeof raw.created_at === 'string' && raw.created_at.length > 0);
  const expectedMetrics = {
    jk_bits: compiled.nodes.length, jk_bits_max: compiled.nodes.length,
    ex_operation_sum: compiled.nodes.reduce((sum, node) => sum + node.tokens.length, 0),
    ex_operation_max: Math.max(...compiled.nodes.map(node => node.tokens.length)),
    ex_source_sum: compiled.nodes.reduce((sum, node) => sum + node.tokens.filter(token => token.source).length, 0),
    ex_source_max: Math.max(...compiled.nodes.map(node => node.sources.length)),
  };
  for (const [key, value] of Object.entries(expectedMetrics)) assert.equal(raw[key], value, `Model ${key} does not match actual expressions`);
  return { raw, compiled, byId: new Map(compiled.nodes.map(node => [node.id, node])), identity: {
    md5, created_at: raw.created_at,
  } };
}

function verifyRoleStructure(model) {
  const { raw, compiled, byId } = model, roles = raw.spec.roles;
  assert.equal(raw.spec.architecture_mode, 'shared');
  assert.equal(raw.input_bits, 216); assert.equal(raw.output_bits, 72);
  assert.deepEqual(compiled.inputs, Array.from({ length: 216 }, (_, i) => `X${i}`));
  assert.equal(compiled.nodes.length, 512);
  const expectedRanges = { merges: [219, 9], tokens: [228, 9], selected_inputs: [247, 24], core: [271, 168], output_state: [439, 72] };
  for (const [key, [start, count]] of Object.entries(expectedRanges)) assert.deepEqual(roles[key], Array.from({ length: count }, (_, i) => `Q${start + i}`));
  for (const [key, id] of Object.entries({ frame_seed: 'Q216', bootstrap: 'Q217', clock: 'Q218', tick: 'Q237', selector_wrap: 'Q238', core_done: 'Q511' })) assert.equal(roles[key], id);
  assert.deepEqual(roles.selector_thresholds, Array.from({ length: 8 }, (_, i) => `Q${246 - i}`));
  assert.equal(roles.storage.length, 216);
  roles.storage.forEach((id, i) => {
    const name = `Q${i}L${Math.floor(i / 24) + 1}${['R', 'G', 'B'][Math.floor(i / 8) % 3]}${i % 8}`;
    assert.ok(id === `Q${i}` || id === name);
    assert.equal(byId.get(id)?.initial, 0);
    assert.equal(byId.get(id).ex, `J0K(X${i})`);
  });
  const partition = [...roles.storage, roles.frame_seed, roles.bootstrap, roles.clock, ...roles.merges, ...roles.tokens,
    roles.tick, roles.selector_wrap, ...roles.selector_thresholds, ...roles.selected_inputs, ...roles.core, ...roles.output_state, roles.core_done];
  assert.equal(new Set(partition).size, 512);
  assert.deepEqual(sorted(partition), sorted(compiled.nodes.map(node => node.id)));
  assert.equal(byId.get(roles.bootstrap).initial, 0); assert.equal(byId.get(roles.bootstrap).sources.length, 0);
  const expectedSources = new Map([
    [roles.frame_seed, Array.from({ length: 216 }, (_, i) => `X${i}`)],
    [roles.clock, [roles.bootstrap, roles.core_done]], [roles.tick, [roles.tokens[8]]],
    [roles.core_done, roles.core_outputs], [roles.selector_wrap, [roles.tick, roles.selector_thresholds[7]]],
  ]);
  roles.merges.forEach((id, i) => expectedSources.set(id, [roles.frame_seed, ...(i ? [roles.tokens[i - 1]] : [])]));
  roles.tokens.forEach((id, i) => expectedSources.set(id, [roles.merges[i], roles.clock]));
  roles.selector_thresholds.forEach((id, i) => expectedSources.set(id, [roles.tick, roles.selector_wrap, ...(i ? [roles.selector_thresholds[i - 1]] : [])]));
  for (const [id, expected] of expectedSources) assert.deepEqual(sorted(byId.get(id).sources), sorted(expected), `${id}: control source topology differs`);
  assert.equal(byId.get(roles.frame_seed).initial, 0); assert.equal(byId.get(roles.core_done).initial, 0);
  assert.equal(byId.get(roles.selector_wrap).initial, 0);
  roles.tokens.forEach(id => assert.equal(byId.get(id).initial, 0));
  roles.selector_thresholds.forEach(id => assert.equal(byId.get(id).initial, 1));
  for (const id of [roles.clock, roles.tick, ...roles.merges, ...roles.selected_inputs, ...roles.core]) assert.equal(byId.get(id).initial, null);
  const orderedSelector = [roles.selector_wrap, ...roles.selector_thresholds.toReversed()];
  assert.deepEqual(orderedSelector, sorted(orderedSelector));
  assert.ok(roles.selected_inputs.every(id => order(orderedSelector.at(-1), id) < 0));
  assert.ok(roles.output_state.every(id => order(id, roles.core_done) < 0));
  assert.ok(roles.storage.every(id => order(id, roles.frame_seed) < 0));
  const allowed = new Set([...roles.selected_inputs, ...roles.core]), visiting = new Set(), visited = new Set();
  function visit(id) {
    assert.ok(allowed.has(id), `Shared arithmetic has a foreign dependency: ${id}`);
    if (roles.selected_inputs.includes(id) || visited.has(id)) return;
    assert.ok(!visiting.has(id), `Shared arithmetic cycle: ${id}`);
    visiting.add(id); byId.get(id).sources.forEach(visit); visiting.delete(id); visited.add(id);
  }
  assert.equal(roles.core_outputs.length, 8); roles.core_outputs.forEach(visit);
  assert.deepEqual(sorted(visited), sorted(roles.core));
  return roles;
}

function evaluateNode(node, values) {
  let result = node.initial === null ? 0 : values.get(node.id);
  for (const token of node.tokens) {
    const input = token.source ? values.get(token.source) : token.constant;
    assert.ok(input === 0 || input === 1, `${node.id}: missing proof input ${token.source}`);
    result = token.op === 'J' ? result & input : result ^ input;
  }
  return result;
}

function proveSelectorOrbit(before, after, roles) {
  const ids = [roles.selector_wrap, ...roles.selector_thresholds.toReversed()];
  const initial = new Map(ids.map(id => [id, before.byId.get(id).initial]));
  const state = new Map(initial), seen = new Set(), states = [], checks = Object.fromEntries(ids.map(id => [id, []]));
  const key = () => ids.map(id => state.get(id)).join('');
  while (!seen.has(key())) {
    assert.ok(seen.size < 512, 'Selector orbit failed to close in its complete nine-bit state space');
    seen.add(key()); states.push(Object.fromEntries(state)); state.set(roles.tick, 1);
    for (const id of ids) {
      const old = before.byId.get(id), updated = after.byId.get(id);
      const oldValue = evaluateNode(old, state), newValue = evaluateNode(updated, state);
      assert.equal(newValue, oldValue, `${id}: selector rewrite fails a reachable exact transition`);
      checks[id].push({ old_q: state.get(id), source_values: Object.fromEntries(old.sources.map(source => [source, state.get(source)])), result: oldValue });
      state.set(id, oldValue);
    }
    state.delete(roles.tick);
  }
  assert.equal(key(), ids.map(id => initial.get(id)).join(''), 'Selector orbit does not return to its initialized state');
  assert.equal(states.length, 9, 'Expected exactly the nine legal selector boundary states');
  return {
    method: 'Exact reachable-state orbit with sequential current-q reads, Tick=1, and the structurally checked wrap / s8..s1 execution order',
    reachable_boundary_states: states, orbit_length: states.length,
    local_transition_checks: Object.values(checks).reduce((sum, entries) => sum + entries.length, 0), per_node: checks,
    induction: 'Initialization is the first recorded state; each exact transition returns a recorded state, and the orbit closes at initialization. This proves arbitrarily many complete selector cycles under the declared Tick protocol, not arbitrary initial states or arbitrary interleavings.',
  };
}

function graphReview(model, roles) {
  const { compiled, byId } = model, live = new Set();
  function visit(id) {
    if (id.startsWith('X') || live.has(id)) return;
    live.add(id); byId.get(id).sources.forEach(visit);
  }
  compiled.outputs.forEach(output => visit(output.source));
  const duplicates = new Map();
  for (const node of compiled.nodes.filter(node => node.initial === null)) {
    const key = canonical({ sources: sorted(node.sources), required: sorted(node.required), anf: anf(node.tokens, node.id, false) });
    if (!duplicates.has(key)) duplicates.set(key, []);
    duplicates.get(key).push(node.id);
  }
  const duplicateCandidates = [...duplicates.values()].filter(ids => ids.length > 1);
  const coreSet = new Set(roles.core), outputSet = new Set(roles.core_outputs), inlineCandidates = [];
  for (const id of roles.core) {
    if (outputSet.has(id)) continue;
    const child = byId.get(id), consumers = roles.core.map(key => byId.get(key)).filter(node => node.sources.includes(id));
    const xorOnly = child.tokens.slice(1).every(token => token.op === 'K');
    const andOnly = child.tokens[1]?.op === 'K' && child.tokens.slice(2).every(token => token.op === 'J');
    if (consumers.length && consumers.every(node => node.tokens.every((token, index) => token.source !== id ||
      (token.op === 'K' && (xorOnly || index === 1)) || (token.op === 'J' && andOnly)))) inlineCandidates.push(id);
  }
  assert.equal(live.size, 512, 'Found a node outside all delivered output dependency ancestry');
  return {
    nodes_in_output_dependency_ancestry: live.size,
    direct_dead_node_deletion_candidates: compiled.nodes.filter(node => !live.has(node.id)).map(node => node.id),
    stateless_same_interface_same_function_merge_candidates: duplicateCandidates,
    safe_duplicate_merges_proven: [],
    core_only_three_rule_inlining_candidates: inlineCandidates,
    core_boundary_nodes_kept: [...outputSet],
    persistent_states_not_merged: compiled.nodes.filter(node => node.initial !== null).length,
    checks: ['All declared nodes parse and are valid', 'Every node belongs to output dependency ancestry', 'Exact independent stateless ANF duplicate search with the same source/arrival interface', 'Fixed-point XOR / AND / reset-prefix inlining scan within the arithmetic core', 'Core output publication boundaries and persistent input/output states retained'],
    boundary: 'Liveness proves only that no node is dead under direct deletion; it does not prove that restructuring cannot remove nodes. A duplicate or inlining candidate is not a safe FIFO merge until publication multiplicity, pairing, ordering and completion are proved. No global minimum node count, arbitrary graph rewrite safety, or hardware optimality is claimed.',
  };
}

function protectInputs(inputs, report) {
  for (const input of inputs) {
    assert.notEqual(resolve(input), resolve(report), 'Report must not overwrite either model');
    if (existsSync(input) && existsSync(report)) {
      assert.notEqual(realpathSync(input), realpathSync(report), 'Report aliases a model');
      const a = statSync(input), b = statSync(report);
      assert.ok(a.dev !== b.dev || a.ino !== b.ino, 'Report is a hard link to a model');
    }
  }
}

/** Pure model-data gate: no reads, writes, timestamps, generation imports or sampling. */
export function auditModels(baselineRaw, optimizedRaw) {
  const report = { passed: false, audit: 'rgb-gray-full-model-ex-audit-v1',
    evidence_boundary: 'Exact expression and declared-invariant proofs, plus graph inspection. Complete-model FIFO equivalence, numerical grayscale truth tables, and execution-time metrics require their separate reports. This does not prove that 512 nodes, the 168-node arithmetic graph, or every larger expression is globally minimal.',
  };
  try {
    const before = loadRawModel(baselineRaw), after = loadRawModel(optimizedRaw);
    report.baseline_identity = before.identity; report.model_identity = after.identity;
    const roles = verifyRoleStructure(before); verifyRoleStructure(after);
    assert.deepEqual(before.raw.spec.roles, after.raw.spec.roles, 'Role interfaces changed');
    for (const key of ['initial_q', 'q_y', 'inputs', 'outputs']) assert.deepEqual(after.raw[key], before.raw[key], `${key} changed`);
    assert.deepEqual(after.compiled.inputs, before.compiled.inputs);
    assert.deepEqual(after.compiled.nodes.map(node => node.id), before.compiled.nodes.map(node => node.id), 'Node identity or dispatch ordering changed');
    // Establish the source topology and unconditional constant publishers before
    // applying induction hypotheses to the shorter conditional implementations.
    for (const id of [roles.frame_seed, roles.clock, ...roles.merges, ...roles.tokens, roles.tick, roles.core_done]) {
      assert.deepEqual(anf(before.byId.get(id).tokens, id, before.byId.get(id).initial !== null), [''], `${id}: baseline is not an unconditional constant-one publisher`);
    }
    const bootstrap = before.byId.get(roles.bootstrap);
    assert.deepEqual(anf(bootstrap.tokens, bootstrap.id, true, { [bootstrap.id]: 0 }), ['']);
    const selectorProof = proveSelectorOrbit(before, after, roles);
    report.invariant_proofs = {
      control_one: {
        proof_kind: 'structural initialization and induction, with exact ANF under the indicated values',
        statements: [
          'Bootstrap has no sources, starts with q=0, executes once at initialization, publishes 1, and has no later activation source. Reset restores this premise.',
          'Clock can execute only after Bootstrap or CoreDone publication. Bootstrap has already published 1 on the first clock event and retains 1 thereafter.',
          'No merge/token/tick cycle can start before FrameSeed: tokens require stateless merge and clock arrivals. FrameSeed publishes 1 only after all input arrivals; it retains 1 until reset.',
          'Each merge therefore reads FrameSeed=1. Clock arrivals and merge arrivals are 1, so each token publishes and stores 1; each Tick reads T8=1.',
          'CoreDone is an unconditional constant-one publisher requiring all eight arithmetic output arrivals. Its feedback preserves Clock=1. Induction closes without assuming a bounded sample run.',
        ],
        exclusions: 'No externally forced node enqueue, overlapping frames, arbitrary initial states or unvalidated controller rewiring is covered.',
      },
      selector: selectorProof,
    };
    const nodes = [];
    for (const old of before.compiled.nodes) {
      const node = after.byId.get(old.id), stateful = old.initial !== null;
      assert.equal(node.initial, old.initial, `${old.id}: state initialization changed`);
      assert.deepEqual(sorted(node.sources), sorted(old.sources), `${old.id}: sources changed`);
      assert.deepEqual(sorted(node.required), sorted(old.required), `${old.id}: required arrivals changed`);
      const unconditional = proveJKExpression({ id: old.id, beforeEx: old.ex, afterEx: node.ex, stateful });
      let proof;
      if (unconditional.equivalent) proof = { ...unconditional, proof_kind: old.ex === node.ex ? 'identical_expression' : 'unconditional_equivalence' };
      else if (Object.hasOwn(selectorProof.per_node, old.id)) proof = {
        proof_kind: 'selector_reachable_state_invariant', equivalent: true,
        transition_cases: selectorProof.per_node[old.id],
        premise: 'Tick=1, declared initialized nine-state orbit, and sequential wrap then s8..s1 updates',
      };
      else {
        let known;
        if (old.id === roles.bootstrap) known = { [roles.bootstrap]: 0 };
        else if (old.id === roles.clock) known = { [roles.bootstrap]: 1 };
        else if (roles.merges.includes(old.id)) known = { [roles.frame_seed]: 1 };
        else if (roles.tokens.includes(old.id)) known = { [roles.clock]: 1, [roles.merges[roles.tokens.indexOf(old.id)]]: 1 };
        else if (old.id === roles.tick) known = { [roles.tokens[8]]: 1 };
        assert.ok(known, `${old.id}: rewrite has no admitted exact proof`);
        proof = proveJKExpression({ id: old.id, beforeEx: old.ex, afterEx: node.ex, stateful, knownValues: known });
        assert.ok(proof.equivalent, `${old.id}: conditional ANF equivalence failed`);
        proof.proof_kind = old.id === roles.bootstrap ? 'initialization_once_invariant' : 'controller_constant_one_invariant';
      }
      nodes.push({
        id: node.id, changed: node.ex !== old.ex, before_ex: old.ex, after_ex: node.ex,
        before_operations: old.tokens.length, after_operations: node.tokens.length,
        before_initial_q: old.initial, after_initial_q: node.initial,
        before_sources: sorted(old.sources), after_sources: sorted(node.sources),
        before_required: sorted(old.required), after_required: sorted(node.required),
        source_set_preserved: true, arrival_classification_preserved: true, initial_state_preserved: true, proof,
        conclusion: node.ex === old.ex ? 'retained_with_exact_identity' : 'changed_with_exact_declared_proof',
      });
    }
    const coreAudit = auditPrimitiveExpressions({ name: 'actual 168-node shared arithmetic core', nodes: roles.core.map(id => after.byId.get(id)), initial_q: { '0': [], '1': [] } });
    const bfs = coreAudit.node_audits.filter(node => node.local_minimum.explored_states !== undefined);
    const bounds = coreAudit.node_audits.filter(node => node.local_minimum.status === 'minimum_in_declared_local_class' && node.local_minimum.explored_states === undefined);
    const retained = coreAudit.node_audits.filter(node => node.local_minimum.status === 'checked_minimum_not_proven');
    assert.equal(bfs.length, 141); assert.equal(bounds.length, 8); assert.equal(retained.length, 19);
    assert.ok(coreAudit.node_audits.every(node => node.local_minimum.status !== 'shorter_unconditional_expression_found'), 'Core has a proved shorter expression that was not applied');
    assert.ok(retained.every(node => node.local_minimum.applicable_local_patterns.length === 0), 'A retained larger core expression has an unreviewed local simplification pattern');
    report.core_expression_audit = { ...coreAudit, exact_bfs_nodes: bfs.length, source_lower_bound_nodes: bounds.length,
      checked_but_minimum_not_proven_nodes: retained.map(node => node.id) };
    report.primitive_node_lower_bound = { full_adder: proveFullAdderNodeLowerBound() };
    const knownCeilings = new Map([
      [roles.frame_seed, 218], [roles.bootstrap, 1], [roles.clock, 3], [roles.tick, 2],
      [roles.selector_wrap, 2], [roles.core_done, 10],
    ]);
    roles.storage.forEach(id => knownCeilings.set(id, 2));
    roles.merges.forEach((id, i) => knownCeilings.set(id, i ? 3 : 2));
    roles.tokens.forEach(id => knownCeilings.set(id, 3));
    roles.selector_thresholds.forEach((id, i) => knownCeilings.set(id, i ? 3 : 2));
    roles.selected_inputs.forEach(id => knownCeilings.set(id, 27));
    for (const audit of nodes) {
      const core = coreAudit.node_audits.find(node => node.id === audit.id);
      if (core) audit.local_minimum = core.local_minimum;
      else if (roles.output_state.includes(audit.id)) {
        audit.local_minimum = localMinimum(after.byId.get(audit.id));
        assert.notEqual(audit.local_minimum.status, 'shorter_unconditional_expression_found', `${audit.id}: proved shorter output expression was not applied`);
      }
      else audit.local_minimum = { status: 'interface_and_rewrite_proof_checked', boundary: 'No unrestricted shortest-expression claim is made for stateful/control expressions.' };
      if (knownCeilings.has(audit.id)) {
        audit.known_proved_operation_ceiling = knownCeilings.get(audit.id);
        assert.ok(audit.after_operations <= audit.known_proved_operation_ceiling,
          `${audit.id}: a known proved simplification was not applied (${audit.after_operations} > ${audit.known_proved_operation_ceiling})`);
      }
    }
    report.node_audits = nodes;
    report.graph_audit = graphReview(after, roles);
    report.coverage = {
      total_nodes: after.compiled.nodes.length, audited_nodes: nodes.length,
      changed_nodes: nodes.filter(node => node.changed).length,
      unchanged_nodes: nodes.filter(node => !node.changed).length,
      before_stored_operations: nodes.reduce((sum, node) => sum + node.before_operations, 0),
      after_stored_operations: nodes.reduce((sum, node) => sum + node.after_operations, 0),
      proof_kinds: Object.fromEntries([...new Set(nodes.map(node => node.proof.proof_kind))].map(kind => [kind, nodes.filter(node => node.proof.proof_kind === kind).length])),
    };
    report.global_optimum_proven = false;
    report.passed = true;
  } catch (error) { report.error = { name: error.name, message: error.message }; }
  return report;
}

export function auditRgbGrayEx(baselinePath, modelPath, reportPath) {
  const files = [resolve(baselinePath), resolve(modelPath)], reportFile = resolve(reportPath);
  protectInputs(files, reportFile);
  let report;
  const identities = files.map(path => ({ path, md5: null, created_at: null, file_sha256: null }));
  try {
    const models = files.map((path, index) => {
      const bytes = readFileSync(path); identities[index].file_sha256 = sha(bytes);
      const raw = JSON.parse(bytes);
      identities[index].md5 = raw.md5 ?? null; identities[index].created_at = raw.created_at ?? null;
      return raw;
    });
    report = auditModels(...models);
  } catch (error) {
    report = { passed: false, audit: 'rgb-gray-full-model-ex-audit-v1', error: { name: error.name, message: error.message } };
  }
  report.baseline_identity = { ...identities[0], ...report.baseline_identity };
  report.model_identity = { ...identities[1], ...report.model_identity };
  report.identity_boundary = 'A failed audit may retain an unvalidated declared MD5; only passed=true certifies that both model MD5 values were recomputed and matched.';
  report.generated_at = new Date().toISOString();
  report.auditor_identity = { path: SELF_FILE, file_sha256: sha(readFileSync(SELF_FILE)), node_version: process.version };
  report.engine_identity = { path: ENGINE_FILE, file_sha256: sha(readFileSync(ENGINE_FILE)) };
  protectInputs(files, reportFile); mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 5, 'Usage: node scripts/audit-rgb-gray-ex.mjs BASELINE MODEL REPORT');
    const report = auditRgbGrayEx(...process.argv.slice(2));
    console.log(JSON.stringify({ passed: report.passed, report: resolve(process.argv[4]), coverage: report.coverage, ...(report.error ? { error: report.error.message } : {}) }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
