import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as defaultEngine from '../skills/jk-network-generator/scripts/engine.mjs';
import { digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => createHash('sha256').update(value).digest('hex');
const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const ids = (prefix, start, count) => range(start, count).map(i => prefix + i);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SEED = 0x51209a73;
const BOUNDARY = 'Sampled 216-bit frame domain using actual JKEngine.send/step. Every Xi appears once per frame; disjoint partial sends and stepping between sends are allowed. A new frame starts only after the preceding frame completes and returns to the idle token marking. Each output bit publishes nine times per frame, retaining its preceding value until its pixel round. The complete 72-bit result is valid after all nine rounds, not atomically before then. No claim covers overlapping frames, duplicate input sends within a frame, arbitrary initial state, all 2^216 input combinations, external hardware, browser integration or global node-count optimality.';
const TERMINATION = [
  'Independently proved local functions and checked complete source sets restrict the only feedback to CoreDone -> C -> Ti, Ti -> M(i+1), T8 -> Tick, selector state, and output-state readback. Arithmetic is a forward-only stateless DAG; output self-publication cannot enqueue without a fresh core-bit arrival.',
  'One complete frame publishes FrameSeed exactly once. M0 consequently publishes once, so T0 consumes at most one M0 token. Mi receives one FrameSeed event and one event per T(i-1) publication; therefore Ti publishes at most i+1 times. T8 can produce at most nine Tick events, regardless of input values. This is a structural finite-event bound, not a conclusion inferred from a step timeout.',
  'From the checked idle marking (one C arrival cached at every Ti), FIFO order generates token waves [T0..T8], [T1..T8], ..., [T8]. Each Tick advances the selector, reads one pixel, runs the arithmetic DAG, writes all 72 output states and then publishes CoreDone. C replenishes the token slots; each successive wave is one token shorter. After wave nine there are no remaining M arrivals, and only nine cached C arrivals remain.',
  'The exact per-frame bound and successful schedule comprise 216 storage executions, one FrameSeed, 45 M, 45 T, nine C, nine Tick, 81 selector-state, 216 selected-input, 1512 arithmetic-core, 648 output-state and nine CoreDone executions: 2791 total. Initialization is separate: Bootstrap then C, two executions.',
  'Bootstrap is the only source-free node and has no incoming trigger references, so it executes once with declared old q=0. Its pulse is one; constant-polynomial proofs establish FrameSeed/CoreDone pulses independently of data and old q. C always reads Bootstrap=1, M reads FrameSeed=1, T reads C=1, and Tick reads T8=1. These pulse premises are preserved around the bounded feedback and checked at actual executions.',
  'Initially thresholds s1..s8 are all one and wrap is zero. At Tick boundaries they form a thermometer and old_wrap AND old_s8=0. Wrap reads old_s8 first; its new value being one implies every old threshold is one. Descending s8..s1 updates read each unchanged predecessor and produce the next thermometer (8 wraps to 0); new_wrap AND new_s8 remains zero. Local transition enumeration proves this invariant inductively, and the FIFO trace checks old q, source reads and update order.',
];

function storageId(i, profile) {
  return profile === 'numeric-compatibility' ? 'Q' + i : `Q${i}L${Math.floor(i / 24) + 1}${'RGB'[Math.floor(i / 8) % 3]}${i % 8}`;
}

// Independent execution of a single parsed expression. A self source is the
// execution's original q, not the evolving accumulator and not a free variable.
function localValue(node, values, oldQ = 0) {
  let value = node.initial === null ? 0 : oldQ;
  for (const token of node.tokens) {
    const input = token.source === node.id ? oldQ : token.source ? values.get(token.source) : token.constant;
    assert(input === 0 || input === 1, `Missing local input ${token.source} for ${node.id}`);
    value = token.op === 'J' ? value & input : value ^ input;
  }
  return value;
}

// Boolean polynomials over GF(2), represented by sets of square-free monomials.
// J multiplies by one input bit (x*x=x); K toggles one monomial. This proves
// constant-pulse identities for 216 independent inputs without enumerating 2^216.
// This implementation has no dependency on the generator or its optimizer.
function proveConstant(node, expected, fixed = new Map(), fixedOldQ = null) {
  const sourceMasks = new Map(node.sources.filter(id => id !== node.id).map((id, i) => [id, 1n << BigInt(i)]));
  const qMask = 1n << BigInt(sourceMasks.size);
  let terms = node.initial === null || fixedOldQ === 0 ? new Set() : fixedOldQ === 1 ? new Set([0n]) : new Set([qMask]);
  const toggle = (set, term) => set.has(term) ? set.delete(term) : set.add(term);
  for (const token of node.tokens) {
    let constant = token.constant, mask = null;
    if (token.source) {
      if (token.source === node.id && fixedOldQ !== null) constant = fixedOldQ;
      else if (fixed.has(token.source)) constant = fixed.get(token.source);
      else mask = token.source === node.id ? qMask : sourceMasks.get(token.source);
    }
    if (mask !== null) {
      if (token.op === 'K') toggle(terms, mask);
      else { const next = new Set(); for (const term of terms) toggle(next, term | mask); terms = next; }
    } else if (token.op === 'J') {
      if (constant === 0) terms.clear();
    } else if (constant === 1) toggle(terms, 0n);
  }
  assert(expected === 0 ? terms.size === 0 : terms.size === 1 && terms.has(0n), `${node.id} does not prove the required constant ${expected} under its established preconditions`);
}

/** Check actual local functions and exact dependency roles, not expression text. */
export function validate(raw, { engineModule = defaultEngine } = {}) {
  assert(object(raw) && object(raw.spec), 'Expected a model and spec object');
  assert(raw.format === 'jk-logic-structure-V3.1.0', 'Unexpected model format');
  assert(typeof raw.name === 'string' && raw.name.length > 0, 'Missing model name');
  assert(typeof raw.created_at === 'string' && Number.isFinite(Date.parse(raw.created_at)) && new Date(raw.created_at).toISOString() === raw.created_at, 'Invalid ISO UTC created_at');
  assert(raw.architecture_mode === 'shared' && raw.spec.architecture_mode === 'shared', 'Expected shared architecture');
  assert(raw.input_bits === 216 && raw.output_bits === 72, 'Expected 216 input bits and 72 output bits');
  assert(raw.spec.signed === false && raw.spec.bit_order === 'LSB-first', 'Expected unsigned LSB-first spec');
  assert(['pixel-suffixed', 'numeric-compatibility'].includes(raw.spec.id_profile), 'Unknown ID profile');
  for (const [key, width] of [['input_bits', 216], ['output_bits', 72]]) assert(!Object.hasOwn(raw.spec, key) || raw.spec[key] === width, `Wrong spec.${key}`);
  assert(Array.isArray(raw.nodes) && raw.nodes.length === 512, 'Shared architecture must contain exactly 512 nodes');
  assert(raw.nodes.every(n => object(n) && typeof n.id === 'string' && typeof n.ex === 'string'), 'Invalid node data');
  const expectedRoles = {
    storage: range(0, 216).map(i => storageId(i, raw.spec.id_profile)),
    frame_seed: 'Q216', bootstrap: 'Q217', clock: 'Q218',
    merges: ids('Q', 219, 9), tokens: ids('Q', 228, 9), tick: 'Q237',
    selector_wrap: 'Q238', selector_thresholds: ids('Q', 239, 8).reverse(),
    selected_inputs: ids('Q', 247, 24), core: ids('Q', 271, 168),
    output_state: ids('Q', 439, 72), core_done: 'Q511',
  };
  const roles = raw.spec.roles;
  assert(object(roles), 'Missing shared roles');
  for (const [key, value] of Object.entries(expectedRoles)) assert(same(roles[key], value), `Incorrect role assignment ${key}`);
  assert(Array.isArray(roles.core_outputs) && roles.core_outputs.length === 8 && new Set(roles.core_outputs).size === 8 && roles.core_outputs.every(id => expectedRoles.core.includes(id)), 'Eight distinct arithmetic core outputs are required');
  const model = engineModule.compileModel(raw);
  assert(model.issues.length === 0, 'Compiler issues: ' + model.issues.join('; '));
  const errors = model.nodes.filter(n => n.errors.length);
  assert(errors.length === 0, 'Invalid nodes: ' + errors.slice(0, 10).map(n => `${n.id}: ${n.errors.join(', ')}`).join('; '));
  assert(model.outputs.every(o => !o.error), 'Invalid output mapping');
  assert(same(model.inputs, ids('X', 0, 216)), 'Actual input set must equal X0..X215');
  assert(same(model.outputs.map(o => o.id), ids('Y', 0, 72)), 'Actual output set must equal Y0..Y71');
  assert(same(raw.inputs, ids('X', 0, 216).map(id => ({ [id]: id }))), 'Input metadata mismatch');
  assert(same(raw.outputs, ids('Y', 0, 72).map(id => ({ [id]: id }))), 'Output metadata mismatch');
  assert(same(raw.q_y, roles.output_state.map((id, i) => ({ ['Y' + i]: id }))), 'Each output must mirror its corresponding output-state node');
  const indexById = new Map(model.nodes.map((n, i) => [n.id, i]));
  const stateIds = [...roles.storage, roles.frame_seed, roles.bootstrap, ...roles.tokens, roles.selector_wrap, ...roles.selector_thresholds, ...roles.output_state, roles.core_done];
  const stateSet = new Set(stateIds), oneSet = new Set(roles.selector_thresholds);
  assert(stateSet.size === 309, 'Expected 309 distinct persistent-state nodes');
  for (const bit of [0, 1]) {
    const actual = raw.initial_q?.[bit];
    const wanted = stateIds.filter(id => Number(oneSet.has(id)) === bit);
    assert(Array.isArray(actual) && actual.length === wanted.length && new Set(actual).size === actual.length && wanted.every(id => actual.includes(id)), `Incorrect initial_q[${bit}]`);
  }
  const dependency = (index, sources, required) => {
    const n = model.nodes[index];
    assert(n.sources.length === sources.length && sources.every(id => n.sources.includes(id)), `Wrong complete source set for ${n.id}`);
    assert(n.required.length === required.length && required.every(id => n.required.includes(id)), `Wrong arrival requirements for ${n.id}`);
    return n;
  };
  for (let i = 0; i < 512; i++) {
    const n = model.nodes[i];
    assert(n.id === (i < 216 ? roles.storage[i] : 'Q' + i), `Node ID/order mismatch at ${i}`);
    assert(n.initial === (stateSet.has(n.id) ? Number(oneSet.has(n.id)) : null), `Incorrect state classification for ${n.id}`);
    assert(n.sources.length > 0 || i === 217, `Unexpected initialization-only source ${n.id}`);
  }
  const localChecks = { storage_cases: 0, pulse_polynomial_proofs: 0, selector_transition_cases: 0, selected_input_cases: 0, output_update_cases: 0 };
  const pulse = (node, fixed, oldQ = null) => { proveConstant(node, 1, new Map(fixed), oldQ); localChecks.pulse_polynomial_proofs++; };
  for (let i = 0; i < 216; i++) {
    const n = dependency(i, ['X' + i], ['X' + i]);
    for (const q of [0, 1]) for (const x of [0, 1]) {
      assert(localValue(n, new Map([['X' + i, x]]), q) === x, `Storage ${n.id} does not independently replace its old q with Xi`);
      localChecks.storage_cases++;
    }
  }
  pulse(dependency(216, ids('X', 0, 216), ids('X', 0, 216)), []);
  // Only source-free Bootstrap is initially queued; no incoming source can
  // enqueue it again, so its declared initial q=0 is a proved execution premise.
  pulse(dependency(217, [], []), [], 0);
  pulse(dependency(218, [roles.bootstrap, roles.core_done], []), [[roles.bootstrap, 1]]);
  for (let i = 0; i < 9; i++) {
    pulse(dependency(219 + i, [roles.frame_seed, ...(i ? [roles.tokens[i - 1]] : [])], []), [[roles.frame_seed, 1]]);
    pulse(dependency(228 + i, [roles.merges[i], roles.clock], [roles.merges[i], roles.clock]), [[roles.clock, 1]]);
  }
  pulse(dependency(237, [roles.tokens[8]], []), [[roles.tokens[8], 1]]);
  const wrap = dependency(238, [roles.tick, roles.selector_thresholds[7]], [roles.tick]);
  for (const oldWrap of [0, 1]) for (const oldS8 of [0, 1]) if (!(oldWrap & oldS8)) {
    assert(localValue(wrap, new Map([[roles.tick, 1], [roles.selector_thresholds[7], oldS8]]), oldWrap) === oldS8, 'Wrap does not copy old s8 under old_wrap & old_s8 = 0');
    localChecks.selector_transition_cases++;
  }
  for (let k = 0; k < 8; k++) {
    const n = dependency(indexById.get(roles.selector_thresholds[k]), [roles.tick, roles.selector_wrap, ...(k ? [roles.selector_thresholds[k - 1]] : [])], [roles.tick]);
    for (let previousPixel = 0; previousPixel < 9; previousPixel++) {
      const oldQ = Number(previousPixel > k), oldPredecessor = Number(previousPixel >= k), newWrap = Number(previousPixel === 8);
      assert(!newWrap || oldQ === 1, 'Invalid proof premise: wrap must imply the old threshold is one');
      const values = new Map([[roles.tick, 1], [roles.selector_wrap, newWrap]]);
      if (k) values.set(roles.selector_thresholds[k - 1], oldPredecessor);
      const wanted = (1 - newWrap) & (k ? oldPredecessor : 1);
      assert(localValue(n, values, oldQ) === wanted, `Threshold ${n.id} does not advance the thermometer using its old predecessor`);
      assert(wanted === Number((previousPixel === 8 ? 0 : previousPixel + 1) > k), 'Selector transition does not preserve the thermometer invariant');
      localChecks.selector_transition_cases++;
    }
  }
  for (let bit = 0; bit < 24; bit++) {
    const pixelBits = range(0, 9).map(pixel => roles.storage[pixel * 24 + bit]);
    const n = dependency(247 + bit, [roles.tick, ...pixelBits, ...roles.selector_thresholds], [roles.tick]);
    const values = new Map([[roles.tick, 1]]);
    for (let pixel = 0; pixel < 9; pixel++) {
      roles.selector_thresholds.forEach((id, k) => values.set(id, Number(pixel > k)));
      for (let pattern = 0; pattern < 512; pattern++) {
        pixelBits.forEach((id, p) => values.set(id, (pattern >>> p) & 1));
        assert(localValue(n, values) === ((pattern >>> pixel) & 1), `Selected input ${n.id} does not select the saved bit for pixel ${pixel + 1}`);
        localChecks.selected_input_cases++;
      }
    }
  }
  for (const id of roles.core) {
    const n = model.nodes[indexById.get(id)];
    assert(n.tokens[0].text === 'J0' && n.sources.length > 0 && n.sources.every(source => source.startsWith('Q') && indexById.get(source) >= 247 && indexById.get(source) < indexById.get(id)), `Arithmetic core must be a forward DAG over selected input bits: ${id}`);
    assert(same(n.required, n.sources), `Core must wait for all source arrivals: ${id}`);
  }
  const live = new Set(), pending = [...roles.core_outputs];
  while (pending.length) {
    const id = pending.pop();
    if (live.has(id)) continue;
    live.add(id);
    const n = model.nodes[indexById.get(id)];
    if (indexById.get(id) >= 271) pending.push(...n.sources);
  }
  assert([...roles.core, ...roles.selected_inputs].every(id => live.has(id)), 'Arithmetic core/selected input contains disconnected nodes');
  for (let pixel = 0; pixel < 9; pixel++) for (let bit = 0; bit < 8; bit++) {
    const i = pixel * 8 + bit, self = roles.output_state[i], source = roles.core_outputs[bit];
    const n = dependency(439 + i, [self, source, ...(pixel < 8 ? [roles.selector_thresholds[pixel]] : []), ...(pixel > 0 ? [roles.selector_thresholds[pixel - 1]] : [])], [source]);
    for (let selectedPixel = 0; selectedPixel < 9; selectedPixel++) for (const oldQ of [0, 1]) for (const newValue of [0, 1]) {
      const values = new Map([[source, newValue]]);
      roles.selector_thresholds.forEach((id, k) => values.set(id, Number(selectedPixel > k)));
      assert(localValue(n, values, oldQ) === (selectedPixel === pixel ? newValue : oldQ), `Output state ${n.id} does not conditionally write its selected pixel`);
      localChecks.output_update_cases++;
    }
  }
  pulse(dependency(511, roles.core_outputs, roles.core_outputs), []);
  for (const [key, value] of Object.entries(metrics(raw.nodes))) assert(raw[key] === value, `Incorrect statistic ${key}`);
  assert(raw.md5 === digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec }), 'Structural MD5 mismatch');
  // Check the crucial target ordering rather than assuming array order is FIFO order.
  for (const targets of model.targets.values()) {
    assert(targets.every((n, i) => i === 0 || indexById.get(targets[i - 1].id) < indexById.get(n.id)), 'Target dispatch must follow numeric ID order');
  }
  return { model, roles, indexById, stateIds, oneSet, localChecks };
}

export function expectedGray(bytes) {
  assert(bytes.length === 27 && Array.from(bytes).every(x => Number.isInteger(x) && x >= 0 && x <= 255), 'Expected 27 unsigned RGB bytes');
  return range(0, 9).map(p => Math.floor((77 * bytes[p * 3] + 150 * bytes[p * 3 + 1] + 29 * bytes[p * 3 + 2] + 128) / 256));
}
const uniform = (r, g = r, b = r) => Uint8Array.from({ length: 27 }, (_, i) => [r, g, b][i % 3]);
const bitsOf = bytes => Uint8Array.from({ length: 216 }, (_, i) => (bytes[Math.floor(i / 8)] >>> (i % 8)) & 1);

export function verify(raw, { samples = 10000, engineModule = defaultEngine, reload = () => JSON.parse(JSON.stringify(raw)), progress = null } = {}) {
  const coverage = { boundary_frames: 0, gray_identity_frames: 0, one_hot_frames: 0, one_cold_frames: 0, random_frames: 0, repeated_frames: 0, missing_one_bit_frames: 0, one_bit_partial_frames: 0, interleaved_step_frames: 0, reset_frames: 0, reload_frames: 0, cold_start_frames: 0, initialization_checks: 0, partial_reset_checks: 0, computing_reset_checks: 0, computing_reload_checks: 0 };
  let phase = 'structure', checked, engine, current = null, executions = 0, operationExecutions = 0, peak = 0, completed = 0;
  const started = performance.now(), unique = new Set();
  try {
    assert(Number.isInteger(samples) && samples > 0 && samples <= 1000000, 'samples must be in 1..1000000');
    checked = validate(raw, { engineModule });
    const engineOptions = { historyLimit: 0, queueLimit: 10000 };
    engine = new engineModule.JKEngine(checked.model, engineOptions);
    const countExpected = Uint8Array.from({ length: 512 }, (_, i) => i < 217 ? 1 : i === 217 ? 0 : i >= 219 && i <= 236 ? (i < 228 ? i - 218 : i - 227) : 9);
    assert(countExpected.reduce((sum, value) => sum + value, 0) === 2791, 'Internal expected execution count error');
    const frameOperationExpected = countExpected.reduce((sum, count, index) => sum + count * checked.model.nodes[index].tokens.length, 0);
    const startupOperationExpected = checked.model.nodes[217].tokens.length + checked.model.nodes[218].tokens.length;
    const tokenOrder = range(0, 9).flatMap(start => range(start, 9 - start));

    function assertIdle() {
      assert(engine.length === 0, 'Idle shared model has queued work');
      assert(engine.counts.get(checked.model.nodes[217].key) === 1 && engine.q.get(checked.roles.bootstrap) === 1, 'Bootstrap must have executed once and retained its initial pulse');
      for (let i = 0; i < 512; i++) {
        const cache = engine.cache.get(checked.model.nodes[i].key);
        if (i >= 228 && i <= 236) assert(cache.size === 1 && cache.get(checked.roles.clock) === 1, `Idle ${checked.model.nodes[i].id} must retain exactly one C arrival`);
        else assert(cache.size === 0, `Unexpected idle arrival cache at ${checked.model.nodes[i].id}`);
      }
      assert(checked.roles.selector_thresholds.every(id => engine.q.get(id) === 1) && engine.q.get(checked.roles.selector_wrap) === 0, 'Idle selector must be ready to wrap to pixel one');
    }
    function assertUninitialized() {
      assert(engine.total === 0 && engine.length === 1 && engine.itemAt(0).node.id === checked.roles.bootstrap, 'Initialization must queue only Bootstrap');
      assert(engine.q.size === 309 && checked.stateIds.every(id => engine.q.get(id) === Number(checked.oneSet.has(id))), 'Wrong initial q');
      assert([...engine.outputs.values()].every(value => value === null) && [...engine.cache.values()].every(cache => cache.size === 0), 'Reset/reload must clear output publications and arrivals');
      assert(engine.latest.size === 0 && engine.last.size === 0 && [...engine.counts.values()].every(value => value === 0), 'Reset/reload must clear execution bookkeeping');
    }
    function initialize() {
      phase = 'initialization'; assertUninitialized();
      const operationsBefore = operationExecutions;
      for (const id of [checked.roles.bootstrap, checked.roles.clock]) {
        peak = Math.max(peak, engine.length);
        const event = engine.step(); executions++; operationExecutions += event.operations.length;
        assert(event.node === id && event.value === 1, 'Wrong bootstrap execution sequence');
        if (id === checked.roles.bootstrap) assert(event.before === 0 && engine.counts.get(checked.model.nodes[217].key) === 1, 'Bootstrap must execute exactly once from old q=0');
        else assert(event.reads[checked.roles.bootstrap] === 1 && event.reads[checked.roles.core_done] === 0, 'Initialization C has invalid pulse-state premises');
        assert(event.transfers.every(t => !t.target.startsWith('Y')), 'Initialization must not publish gray output');
      }
      assertIdle(); assert(engine.total === 2 && [...engine.outputs.values()].every(value => value === null), 'Initialization must be exactly two executions without output');
      assert(operationExecutions - operationsBefore === startupOperationExpected, 'Initialization JK operation count mismatch');
      coverage.initialization_checks++;
    }
    initialize();

    function checkFrame(bytes, category, schedule = null, cold = false) {
      phase = category; if (cold) assertUninitialized(); else assertIdle();
      const bits = bitsOf(bytes), wanted = expectedGray(bytes), sent = new Uint8Array(216), counts = new Uint8Array(512), publications = new Uint8Array(72);
      const oldStorage = checked.roles.storage.map(id => engine.q.get(id));
      const expectedState = Uint8Array.from(checked.roles.output_state, id => engine.q.get(id));
      const oldOutputs = [...engine.outputs.values()];
      let frameSteps = 0, frameOperations = 0, saved = 0, round = 0, tokenCount = 0, mergeCount = 0, coldStartupSteps = 0, coldStartupOperations = 0;
      let oldSelector = null, oldWrap = null;
      current = { category, rgb_bytes: Array.from(bytes), expected_gray: wanted, actual_gray: null, round, executed: 0 };
      function send(indices) {
        const data = {};
        for (const i of indices) { assert(i >= 0 && i < 216 && Number.isInteger(i) && !sent[i], 'Frame schedule duplicated/invalid input'); sent[i] = 1; data['X' + i] = bits[i]; }
        const event = engine.send(data);
        assert(event.accepted.length === indices.length && event.ignored.length === 0, 'Engine did not accept exactly the sent bits');
      }
      function step() {
        assert(frameSteps < 2791, 'Shared frame exceeded its structurally established event bound');
        peak = Math.max(peak, engine.length);
        const event = engine.step(); executions++;
        assert(event?.type === 'execution', 'Expected actual FIFO execution');
        operationExecutions += event.operations.length;
        const index = checked.indexById.get(event.node);
        if (cold && (index === 217 || index === 218 && coldStartupSteps === 1)) {
          assert(index === (coldStartupSteps === 0 ? 217 : 218) && event.value === 1, 'Cold-start initialization event order mismatch');
          if (index === 217) assert(event.before === 0 && engine.counts.get(checked.model.nodes[217].key) === 1, 'Cold Bootstrap must execute exactly once from old q=0');
          if (index === 218) assert(saved === 216 && counts[216] === 1 && round === 0 && event.reads[checked.roles.bootstrap] === 1 && event.reads[checked.roles.core_done] === 0, 'First cold-start C must follow stored input and precede the first round');
          assert(event.transfers.every(t => !t.target.startsWith('Y')), 'Cold initialization published an output');
          coldStartupSteps++; coldStartupOperations += event.operations.length; return;
        }
        frameSteps++; frameOperations += event.operations.length; current.executed = frameSteps;
        assert(index !== undefined && ++counts[index] <= countExpected[index], `${event.node} exceeded expected per-frame execution count`);
        if (index < 216) {
          assert(sent[index] && event.before === oldStorage[index] && event.value === bits[index], 'Storage failed to retain/replace its own input'); saved++;
        } else if (index === 216) {
          assert(saved === 216 && sent.every(x => x === 1) && checked.roles.storage.every((id, i) => engine.q.get(id) === bits[i]), 'FrameSeed ran before the complete frame was stored');
          assert(event.value === 1, 'FrameSeed must publish 1');
        } else if (index === 218) {
          assert(round >= 1 && counts[511] === round && counts[218] === round && event.value === 1, 'C replenished tokens before CoreDone');
          assert(event.reads[checked.roles.bootstrap] === 1 && event.reads[checked.roles.core_done] === 1, 'C did not read the proved control pulse values');
        } else if (index >= 219 && index <= 227) {
          assert(saved === 216 && counts[216] === 1 && index - 219 === tokenOrder[mergeCount++] && event.value === 1, 'Merge arrival deviated from the finite token-wave order');
          assert(event.reads[checked.roles.frame_seed] === 1, 'Merge did not read FrameSeed pulse one');
        } else if (index >= 228 && index <= 236) {
          assert(index - 228 === tokenOrder[tokenCount++] && event.value === 1, 'Token consumption deviated from the finite token-wave order');
          assert(event.reads[checked.roles.clock] === 1 && event.reads[checked.roles.merges[index - 228]] === 1, 'Token did not consume the proved C/M pulses');
        } else if (index === 237) {
          assert(saved === 216 && counts[216] === 1 && round < 9 && counts[511] === round, 'Tick began before storage or the preceding round completed');
          assert(range(439, 72).every(i => counts[i] === round), 'Tick advanced before all output states finished their preceding round');
          assert(event.reads[checked.roles.tokens[8]] === 1, 'Tick did not read the final token pulse one');
          oldSelector = checked.roles.selector_thresholds.map(id => engine.q.get(id)); oldWrap = engine.q.get(checked.roles.selector_wrap);
          const previousPixel = round === 0 ? 8 : round - 1;
          assert(oldSelector.every((value, k) => value === Number(previousPixel > k)) && !(oldWrap & oldSelector[7]), 'Tick-boundary thermometer or old_wrap AND old_s8 invariant failed');
          round++; current.round = round; assert(event.value === 1, 'Tick must publish 1');
        } else if (index >= 238 && index <= 246) {
          assert(round >= 1 && counts[index] === round, 'Selector state executed out of round');
          assert(event.reads[checked.roles.tick] === 1 && oldSelector !== null, 'Selector did not read a valid Tick pulse');
          if (index === 238) {
            assert(event.before === oldWrap && event.reads[checked.roles.selector_thresholds[7]] === oldSelector[7] && !(event.before & oldSelector[7]), 'Wrap did not read its proved old-state premise before threshold updates');
            assert(range(239, 8).every(i => counts[i] === round - 1), 'Wrap must execute before every threshold update');
          } else {
            const k = checked.roles.selector_thresholds.indexOf(event.node), newWrap = oldSelector[7];
            assert(counts[238] === round && event.before === oldSelector[k] && event.reads[checked.roles.selector_wrap] === newWrap, 'Threshold did not read old q and freshly updated wrap');
            assert(!newWrap || event.before === 1, 'Wrap=1 did not imply this threshold old q=1');
            if (k > 0) assert(event.reads[checked.roles.selector_thresholds[k - 1]] === oldSelector[k - 1] && counts[checked.indexById.get(checked.roles.selector_thresholds[k - 1])] === round - 1, 'Threshold predecessor was overwritten before its descending-order read');
          }
          const value = index === 238 ? Number(round === 1) : Number(checked.roles.selector_thresholds.indexOf(event.node) < round - 1);
          assert(event.value === value && engine.q.get(event.node) === value, 'Selector state transition is incorrect');
        } else if (index >= 247 && index <= 270) {
          assert(range(238, 9).every(i => counts[i] === round) && counts[index] === round, 'Selected RGB read ran before all selector updates');
          assert(event.reads[checked.roles.tick] === 1 && checked.roles.selector_thresholds.every((id, k) => engine.q.get(id) === Number(round - 1 > k)), 'Selected RGB read has an invalid pulse or thermometer');
          assert(event.value === bits[(round - 1) * 24 + index - 247], 'Shared read mux selected the wrong saved RGB bit');
        } else if (index >= 271 && index <= 438) {
          assert(saved === 216 && round >= 1 && counts[index] === round, 'Core execution occurred before complete storage or outside its round');
        } else if (index >= 439 && index <= 510) {
          const output = index - 439, pixel = Math.floor(output / 8), bit = output % 8;
          assert(round >= 1 && counts[index] === round && event.before === expectedState[output], 'Output state did not retain its previous value');
          if (pixel === round - 1) expectedState[output] = (wanted[pixel] >>> bit) & 1;
          assert(event.value === expectedState[output] && engine.q.get(event.node) === expectedState[output], 'Conditional output-state write disagrees with the independent oracle');
        } else if (index === 511) {
          assert(round >= 1 && counts[511] === round && range(439, 72).every(i => counts[i] === round), 'CoreDone ran before all 72 output-state writes finished');
          assert(range(271, 168).every(i => counts[i] === round) && event.value === 1, 'CoreDone did not follow a complete arithmetic round');
        } else assert(false, 'Unexpected bootstrap execution inside a frame');
        for (const transfer of event.transfers) if (transfer.target.startsWith('Y')) {
          const output = Number(transfer.target.slice(1));
          assert(index === 439 + output && ++publications[output] === round && transfer.value === expectedState[output], 'Unexpected output publication or per-round value');
        }
      }
      function drain() { while (engine.length) step(); }
      function assertIncomplete() {
        assert(sent.some(x => x === 0) && counts.slice(216).every(x => x === 0), 'Incomplete input frame started the gray scheduler');
        assert(publications.every(x => x === 0) && same([...engine.outputs.values()], oldOutputs), 'Incomplete frame changed output publications');
        assert(checked.roles.storage.every((id, i) => engine.q.get(id) === (counts[i] ? bits[i] : oldStorage[i])), 'Partial frame changed an unwritten storage bit');
        if (!engine.length) {
          const cache = engine.cache.get(checked.model.nodes[216].key);
          assert(cache.size === saved && engine.step() === null, 'Partial FrameSeed did not retain its arrived inputs while idle');
          for (let i = 217; i < 512; i++) {
            const cache = engine.cache.get(checked.model.nodes[i].key);
            assert(i >= 228 && i <= 236 ? cache.size === 1 && cache.get(checked.roles.clock) === 1 : cache.size === 0, 'Partial frame damaged the initialized token marking');
          }
        }
      }
      if (schedule) schedule({ send, step, drain, assertIncomplete, engine }); else send(range(0, 216));
      drain();
      assert(sent.every(x => x === 1) && counts.every((x, i) => x === countExpected[i]) && frameSteps === 2791, 'Frame did not execute the exact finite shared schedule');
      assert(frameOperations === frameOperationExpected, 'Frame JK operation count differs from the exact schedule');
      if (cold) { assert(coldStartupSteps === 2 && coldStartupOperations === startupOperationExpected, 'Sending before bootstrap did not complete exactly two initialization steps'); coverage.initialization_checks++; }
      assert(round === 9 && tokenCount === 45 && mergeCount === 45 && publications.every(x => x === 9), 'Expected nine rounds and nine publications per output bit');
      const actual = range(0, 9).map(pixel => range(0, 8).reduce((value, bit) => value + engine.outputs.get('Y' + (pixel * 8 + bit)) * (2 ** bit), 0));
      current.actual_gray = actual; assert(same(actual, wanted), 'Final grayscale bytes disagree with independent integer oracle');
      assert(engine.q.size === 309 && checked.roles.storage.every((id, i) => engine.q.get(id) === bits[i]), 'Full RGB frame did not remain stored');
      assertIdle(); const state = [...engine.q.values()]; assert(engine.step() === null && same([...engine.q.values()], state), 'Idle shared state changed without input');
      coverage[category]++; completed++; unique.add(Buffer.from(bytes).toString('hex')); current = null;
      if (progress && completed % 500 === 0) progress({ completed_frames: completed, executions, operation_executions: operationExecutions, elapsed_seconds: (performance.now() - started) / 1000 });
    }
    const boundaries = [uniform(0), uniform(255), uniform(255, 0, 0), uniform(0, 255, 0), uniform(0, 0, 255), uniform(255, 255, 0), uniform(255, 0, 255), uniform(0, 255, 255), uniform(1, 0, 0), uniform(0, 1, 0), uniform(0, 0, 1), uniform(254, 255, 255), uniform(255, 254, 255), uniform(255, 255, 254), uniform(127, 128, 129), uniform(128, 127, 126), Uint8Array.from({ length: 27 }, (_, i) => (i * 73 + 19) & 255), Uint8Array.from({ length: 27 }, (_, i) => i % 2 ? 0x55 : 0xaa)];
    for (const bytes of boundaries) checkFrame(bytes, 'boundary_frames');
    for (let byte = 0; byte < 256; byte++) checkFrame(uniform(byte), 'gray_identity_frames');
    for (let bit = 0; bit < 216; bit++) {
      const hot = new Uint8Array(27), cold = new Uint8Array(27).fill(255);
      hot[Math.floor(bit / 8)] = 1 << (bit % 8); cold[Math.floor(bit / 8)] ^= 1 << (bit % 8);
      checkFrame(hot, 'one_hot_frames'); checkFrame(cold, 'one_cold_frames');
    }
    let seed = SEED;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let i = 0; i < samples; i++) checkFrame(Uint8Array.from({ length: 27 }, () => random() & 255), 'random_frames');
    for (const bytes of [uniform(255), uniform(255), uniform(0), uniform(0), boundaries[16], boundaries[16]]) checkFrame(bytes, 'repeated_frames');
    for (let missing = 0; missing < 216; missing++) checkFrame(Uint8Array.from({ length: 27 }, (_, i) => (missing * 43 + i * 91) & 255), 'missing_one_bit_frames', ({ send, drain, assertIncomplete }) => { send(range(0, 216).filter(i => i !== missing)); drain(); assertIncomplete(); send([missing]); });
    for (const order of [range(0, 216).reverse(), range(0, 216).map(i => (i * 73) % 216)]) checkFrame(boundaries[16], 'one_bit_partial_frames', ({ send, drain, assertIncomplete }) => { for (let i = 0; i < 216; i++) { send([order[i]]); drain(); if (i < 215) assertIncomplete(); } });
    checkFrame(boundaries[17], 'interleaved_step_frames', ({ send, step, assertIncomplete, engine: active }) => { for (let i = 0; i < 216; i += 7) { send(range(i, Math.min(7, 216 - i))); if (active.length) step(); if (i + 7 < 216) assertIncomplete(); } });
    phase = 'reset'; engine.reset(); initialize();
    for (const bytes of [uniform(0), uniform(255), boundaries[16]]) checkFrame(bytes, 'reset_frames');
    phase = 'partial-reset';
    engine.send(Object.fromEntries(range(0, 107).map(i => ['X' + i, 1])));
    while (engine.length) { peak = Math.max(peak, engine.length); const event = engine.step(); executions++; operationExecutions += event.operations.length; }
    assert(engine.cache.get(checked.model.nodes[216].key).size === 107, 'Partial-reset setup did not retain FrameSeed arrivals');
    engine.reset(); initialize(); coverage.partial_reset_checks++; checkFrame(uniform(0), 'reset_frames');
    function interruptComputing() {
      const bits = bitsOf(boundaries[16]); engine.send(Object.fromEntries(range(0, 216).map(i => ['X' + i, bits[i]])));
      const target = engine.counts.get(checked.model.nodes[271].key) + 3;
      let steps = 0;
      while (engine.counts.get(checked.model.nodes[271].key) < target) {
        assert(engine.length > 0 && steps++ < 2791, 'Could not reach the third arithmetic round for interruption');
        peak = Math.max(peak, engine.length); const event = engine.step(); executions++; operationExecutions += event.operations.length;
      }
      assert(engine.length > 0, 'Computation-interruption fixture unexpectedly completed');
    }
    phase = 'computing-reset'; interruptComputing(); engine.reset(); initialize(); coverage.computing_reset_checks++; checkFrame(uniform(255), 'reset_frames');
    phase = 'computing-reload'; interruptComputing();
    const reloaded = reload();
    assert(reloaded.md5 === raw.md5 && reloaded.created_at === raw.created_at && digest(reloaded) === digest(raw), 'Model changed while verification was running');
    checked = validate(reloaded, { engineModule }); engine = new engineModule.JKEngine(checked.model, engineOptions); initialize(); coverage.computing_reload_checks++;
    for (const bytes of [uniform(0), uniform(255), boundaries[16]]) checkFrame(bytes, 'reload_frames');
    phase = 'cold-start'; engine.reset(); checkFrame(boundaries[16], 'cold_start_frames', null, true);
    const staticStatistics = metrics(raw.nodes);
    return { passed: true, verification: 'rgb-gray-shared-fifo-v2', mode: 'sampled', model_md5: raw.md5, model_created_at: raw.created_at, id_profile: raw.spec.id_profile, architecture_mode: 'shared', nodes: 512, persistent_state_bits: 309, input_storage_bits: 216, input_bits: 216, output_bits: 72, initialization_executions: 2, startup_executions: 2, startup_operation_executions: startupOperationExpected, executions_per_frame: 2791, per_frame_node_executions: 2791, per_frame_operation_executions: frameOperationExpected, ex_operation_sum: staticStatistics.ex_operation_sum, ex_operation_max: staticStatistics.ex_operation_max, ex_source_max: staticStatistics.ex_source_max, rounds_per_frame: 9, output_publications_per_bit_per_frame: 9, requested_random_samples: samples, random_seed: '0x' + SEED.toString(16), input_domain_combinations: (1n << 216n).toString(), completed_frames: completed, unique_complete_input_vectors: unique.size, coverage, local_semantic_checks: checked.localChecks, executions, operation_executions: operationExecutions, peak_queue: peak, elapsed_seconds: (performance.now() - started) / 1000, oracle: 'For each row-major RGB pixel: floor((77*R + 150*G + 29*B + 128)/256), unsigned bytes, LSB-first.', checks: ['Independently evaluated local functions, complete source/required sets, state initial values, numeric event dispatch order, public ports, statistics and structural MD5; no extra nodes.', 'Control pulse functions proved by independent Boolean-polynomial normalization; Bootstrap old q=0 and pulse/thermometer/selector-order premises are structurally established and checked during FIFO execution.', 'Real FIFO interpreter; each frame stores all input before scheduling, executes exact finite token waves, selects each saved RGB pixel in turn and checks every conditional output-state write.', 'Each frame executes 2791 steps, nine rounds and nine publications per output bit; idle caches contain only nine C tokens. Actual sequential JK operation counts equal counts derived from the validated execution schedule.', '10,000 random frames by default plus all 256 equal-RGB values, all 216 one-hot/one-cold vectors, boundaries, repeats, each individually missing input and staged/non-drained input sends.', 'Initial bootstrap, reset after complete/partial/computing frames and file reread/recompilation during computation restore declared state and the two-step idle initialization.', 'A full first frame sent before draining Bootstrap also completes correctly; callers do not need a separate initialization drain.'], termination_argument: TERMINATION, boundary: BOUNDARY };
  } catch (error) {
    error.report = { passed: false, verification: 'rgb-gray-shared-fifo-v2', mode: 'sampled', phase, error: error.message, model_md5: raw?.md5 ?? null, model_created_at: raw?.created_at ?? null, requested_random_samples: samples, completed_frames: completed, coverage, counterexample: current, executions, operation_executions: operationExecutions, peak_queue: peak, elapsed_seconds: (performance.now() - started) / 1000, boundary: BOUNDARY };
    throw error;
  }
}

export function assertSeparateFiles(modelPath, reportPath) {
  const a = resolve(modelPath), b = resolve(reportPath); assert(a !== b, 'Report path must not overwrite the model');
  if (existsSync(a) && existsSync(b)) { const sa = statSync(a), sb = statSync(b); assert(sa.dev !== sb.dev || sa.ino !== sb.ino, 'Report aliases model via a symlink or hard link'); }
  const canonical = path => existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), basename(path));
  assert(canonical(a) !== canonical(b), 'Resolved report path must not overwrite the model');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [modelPath, reportPath, ...flags] = process.argv.slice(2);
  let writable = false, phase = 'arguments', identity = {};
  try {
    assert(modelPath && reportPath, 'Usage: node verify-rgb-gray-shared.mjs MODEL REPORT [--samples 10000] [--engine engine.mjs]');
    phase = 'report-path'; assertSeparateFiles(modelPath, reportPath); writable = true;
    phase = 'arguments'; let samples = 10000, enginePath = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
    const supplied = new Set();
    for (let i = 0; i < flags.length; i += 2) { const flag = flags[i], value = flags[i + 1]; assert(['--samples', '--engine'].includes(flag) && value !== undefined && !supplied.has(flag), 'Expected unique --samples N and/or --engine engine.mjs'); supplied.add(flag); if (flag === '--samples') samples = Number(value); else enginePath = resolve(value); }
    const engineModule = await import(pathToFileURL(enginePath).href);
    assert(typeof engineModule.compileModel === 'function' && typeof engineModule.JKEngine === 'function', 'Engine module must export compileModel and JKEngine');
    phase = 'read-model'; const bytes = readFileSync(modelPath), raw = JSON.parse(bytes.toString('utf8'));
    identity = { model_path: realpathSync(modelPath), model_file_sha256: hash(bytes), engine_path: realpathSync(enginePath), engine_sha256: hash(readFileSync(enginePath)), verifier_sha256: hash(readFileSync(fileURLToPath(import.meta.url))), metadata_helper_sha256: hash(readFileSync(new URL('../skills/jk-network-generator/scripts/generate.mjs', import.meta.url))) };
    const result = verify(raw, { samples, engineModule, reload: () => { const bytes = readFileSync(modelPath); assert(hash(bytes) === identity.model_file_sha256, 'Model file changed during verification'); return JSON.parse(bytes.toString('utf8')); }, progress: progress => process.stderr.write(JSON.stringify({ progress }) + '\n') });
    phase = 'write-report'; assertSeparateFiles(modelPath, reportPath); const report = { ...result, ...identity, verified_at: new Date().toISOString() };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify({ passed: true, report: resolve(reportPath), nodes: 512, completed_frames: report.completed_frames, executions: report.executions, elapsed_seconds: report.elapsed_seconds }) + '\n');
  } catch (error) {
    const failure = { ...(error.report ?? { passed: false, phase, error: error.message, mode: 'sampled', boundary: BOUNDARY }), ...identity, verified_at: new Date().toISOString() };
    if (writable && phase !== 'write-report') { try { assertSeparateFiles(modelPath, reportPath); writeFileSync(reportPath, JSON.stringify(failure, null, 2) + '\n'); } catch (error) { process.stderr.write(`Cannot write failure report: ${error.message}\n`); } }
    process.stderr.write(JSON.stringify(failure) + '\n'); process.exitCode = 1;
  }
}
