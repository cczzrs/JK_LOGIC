import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSnapshot, compileModel, parseExpression } from '../skills/jk-network-generator/scripts/model.mjs';
import { JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';
import { buildGrayCore, checkSmallStructures } from './rgb-gray-v4-core.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_PREFIX = path.join(ROOT, 'artifacts/rgb-gray-v4/rgb-gray-216-72');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refs = ex => [...new Set(parseExpression(ex).flatMap(t => t.source ? [t.source] : []))];
const evaluate = (ex, values, before = 0) => parseExpression(ex).reduce((q, t) =>
  t.op === 'J' ? q & (t.source ? values[t.source] : t.constant) : q ^ (t.source ? values[t.source] : t.constant), before);

function selectorExpression(phases, pixel) {
  const a = phases[pixel], b = phases[(pixel + 1) % 9];
  return 'J0' + phases.filter(q => q !== a && q !== b).map(q => `J(${q})`).join('')
    + `K(${a})K(${b})` + (pixel < 8 ? 'K1' : '');
}
function muxExpression(inputs, selectors) {
  return `J0K(${inputs[8]})` + inputs.slice(0, 8).map((q, p) => `K(${q})J(${selectors[p]})K(${q})`).join('');
}

let controlPreflight;
export function checkControlStructures() {
  if (controlPreflight) return structuredClone(controlPreflight);
  const phases = Array.from({ length: 9 }, (_, i) => 'Q' + i);
  const inactive = phases.map((_, i) => selectorExpression(phases, i));
  let selectorCases = 0, muxCases = 0, outputCases = 0;
  // These expressions have unconditional Boolean identities. The one-cold
  // selection property additionally uses the reachable 18 phase transitions.
  for (let mask = 0; mask < 512; mask++) {
    const values = Object.fromEntries(phases.map((q, i) => [q, (mask >> i) & 1]));
    for (let p = 0; p < 9; p++) {
      assert.equal(evaluate(inactive[p], values), values[phases[p]] ^ values[phases[(p + 1) % 9]] ^ Number(p < 8));
      selectorCases++;
    }
  }
  const inputIds = Array.from({ length: 9 }, (_, i) => 'Q' + (10 + i));
  const selectIds = Array.from({ length: 9 }, (_, i) => 'Q' + (20 + i));
  const mux = muxExpression(inputIds, selectIds);
  for (let parity = 0; parity < 2; parity++) for (let p = 0; p < 9; p++) {
    const phaseValues = Object.fromEntries(phases.map((q, i) => [q, parity ^ Number(i <= p)]));
    const selected = inactive.map(ex => evaluate(ex, phaseValues));
    assert.deepEqual(selected, phases.map((_, i) => Number(i !== p)));
    for (let bits = 0; bits < 512; bits++) {
      const values = Object.fromEntries([...inputIds.map((q, i) => [q, (bits >> i) & 1]), ...selectIds.map((q, i) => [q, selected[i]])]);
      assert.equal(evaluate(mux, values), (bits >> p) & 1); muxCases++;
    }
  }
  for (let old = 0; old < 2; old++) for (let bit = 0; bit < 2; bit++) for (let inactiveBit = 0; inactiveBit < 2; inactiveBit++) {
    assert.equal(evaluate('K(Q0)J(Q1)K(Q0)', { Q0: bit, Q1: inactiveBit }, old), inactiveBit ? old : bit); outputCases++;
  }
  // BFS of all old_q/data/inactive truth functions proves the 3-operation
  // stateful output update is shortest for this fixed independent interface.
  const column = i => Array.from({ length: 8 }, (_, r) => ((r >> i) & 1) << r).reduce((a, b) => a | b, 0);
  const old = column(0), data = column(1), sel = column(2), target = ((old ^ data) & sel) ^ data;
  const queue = [{ f: old, used: 0, depth: 0 }], seen = new Set([`${old}:0`]);
  let minimum;
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i]; if (s.f === target && s.used === 3) { minimum = s.depth; break; }
    for (const [v, used] of [[0, 0], [255, 0], [old, 0], [data, 1], [sel, 2]]) for (const f of [s.f & v, s.f ^ v]) {
      const u = s.used | used, key = `${f}:${u}`;
      if (!seen.has(key)) { seen.add(key); queue.push({ f, used: u, depth: s.depth + 1 }); }
    }
  }
  assert.equal(minimum, 3);
  for (let old = 0; old < 2; old++) for (let source = 0; source < 2; source++)
    assert.equal(evaluate('K(Q0)K(Q0)K1', { Q0: source }, old), old ^ 1);
  const fixtureNodes = Array.from({ length: 4 }, (_, i) => ({ id: 'Q' + i, ex: `J0K(X${i})` }));
  fixtureNodes.push({ id: 'Q4', ex: 'J0J(Q0)J(Q1)J(Q2)J(Q3)K1' });
  fixtureNodes.push({ id: 'Q5', ex: 'J0J(Q0)J(Q1)J(Q2)J(Q3)K(Q5)K(Q4)', pro: 'q=0' });
  fixtureNodes.push({ id: 'Q6', ex: 'K(Q5)K(Q5)K1', pro: 'q=0' });
  fixtureNodes.push({ id: 'Q7', ex: 'K(Q6)K(Q6)K1', pro: 'q=0' });
  fixtureNodes.push({ id: 'Q8', ex: 'K(Q7)K1' });
  const fixture = createSnapshot({ nodes: fixtureNodes, input_bits: 4,
    initial_q: { '0': ['Q0', 'Q1', 'Q2', 'Q3', 'Q5', 'Q6', 'Q7', 'Q8'], '1': ['Q4'] }, q_y: [{ Y0: 'Q8' }] });
  const engine = new JKEngine(compileModel(fixture), { historyLimit: 0 });
  let fifoFrames = 0;
  for (const mask of [...Array.from({ length: 16 }, (_, i) => i), 0, 0, 15, 15]) {
    let publications = 0, counterEvents = 0;
    const indices = [3, 1, 0, 2];
    for (let i = 0; i < 4; i++) {
      const b = indices[i]; engine.send({ ['X' + b]: (mask >> b) & 1 });
      while (engine.length) {
        const event = engine.step(); assert.equal(event.type, 'execution');
        if (event.node === 'Q5') counterEvents++;
        for (const transfer of event.transfers) if (transfer.target === 'Y0') { assert.equal(i, 3); publications++; }
      }
    }
    assert.equal(counterEvents, 8); assert.equal(publications, 1);
    assert(['Q5', 'Q6', 'Q7'].every(q => engine.q.get(q) === 0));
    assert.equal(engine.q.get('Q4'), 1); assert.equal(engine.q.get('Q8'), (++fifoFrames) & 1);
    assert([...engine.cache.values()].every(c => c.size === 0));
  }
  engine.reset(); assert.equal(engine.length, 0); assert.equal(engine.outputs.get('Y0'), null);
  controlPreflight = { passed: true, phase: 'before composition', selector_truth_cases: selectorCases,
    one_cold_mux_cases: muxCases, output_update_cases: outputCases, output_update_minimum_operations: minimum,
    weighted_counter_fifo: { passed: true, inputs: 4, input_events_with_padding: 8, counter_bits: 3, frames: fifoFrames,
      coverage: 'All 16 input vectors, repeated zero/one, out-of-order partial sends, wait for last input, idle counters zero, alternating frame phase and reset without tasks.' },
    ripple_counter_proof: 'Each counter toggles, publishes only q=0 and divides event count by two. The 216 input events plus a second path for 40 of them give 256. Every input has positive weight, so missing any input prevents the 256th event. Eight stages emit once and all reset to zero.',
    counter_anchoring: 'Bottom counter: J0 followed by J of every input copy, then K(self)K(padding); padding is initialized 1 and computes only 1, so result is NOT old q. Upper counter: K(source)K(source)K1; source latest-q cancels without assuming the published zero is still current.',
    first_phase_proof: 'Completion counter publishes zero only after all 256 arrivals are consumed. No next frame is allowed during calculation, so it stays zero until the first phase runs; K(completion)K1 toggles that phase.',
    protocol_precondition: 'Every Xi exactly once per frame, arbitrary partition/order, and no next frame until both queues drain.',
    global_optimum_proven: false };
  return structuredClone(controlPreflight);
}

export function generateRgbGrayV4({ created_at, delayAdjustment = 0 } = {}) {
  const preassembly = { arithmetic: checkSmallStructures(), control: checkControlStructures() };
  const nodes = [], initial_q = { '0': [], '1': [] }, role = new Map();
  const reserve = (kind, stateful = false) => {
    const id = 'Q' + nodes.length; nodes.push({ id, ex: '' }); role.set(id, kind);
    if (stateful) initial_q['0'].push(id); return id;
  };
  const set = (id, ex, pro) => { const node = nodes[Number(id.slice(1))]; node.ex = ex; if (pro) node.pro = pro; };
  const inputs = Array.from({ length: 216 }, () => reserve('input', true));
  inputs.forEach((q, i) => set(q, `J0K(X${i})`));
  // Forty input events take two DAG paths, giving exactly 256 positive-
  // weight arrivals. Every missing input removes at least one arrival.
  const weighted_inputs = inputs.slice(0, 40), padding = reserve('padding_one', true);
  initial_q['0'].splice(initial_q['0'].indexOf(padding), 1); initial_q['1'].push(padding);
  set(padding, 'J0' + weighted_inputs.map(q => `J(${q})`).join('') + 'K1');
  const counter_ids = [];
  for (let k = 0; k < 8; k++) {
    const q = reserve(k === 0 ? 'arrival_counter_bottom' : 'arrival_counter_upper', true);
    const prev = counter_ids.at(-1);
    set(q, k === 0 ? 'J0' + inputs.map(s => `J(${s})`).join('') + `K(${q})K(${padding})` : `K(${prev})K(${prev})K1`, 'q=0');
    counter_ids.push(q);
  }
  const completion_counter = counter_ids.at(-1);
  const arrival_groups = [{ input_ids: inputs, counter_ids, bridge: null, event_count: 256 }];
  const phases = Array.from({ length: 9 }, () => reserve('pixel_phase', true));
  const ready = phases[0];
  const selectors = Array.from({ length: 9 }, () => reserve('inactive_selector'));
  selectors.forEach((q, p) => set(q, selectorExpression(phases, p)));
  const selected_rgb = Array.from({ length: 24 }, () => reserve('rgb_mux'));
  selected_rgb.forEach((q, bit) => set(q, muxExpression(Array.from({ length: 9 }, (_, p) => inputs[24 * p + bit]), selectors)));
  const core = buildGrayCore(selected_rgb, nodes.length);
  nodes.push(...core.nodes); core.nodes.forEach(n => role.set(n.id, 'gray_core'));
  const outputs = Array.from({ length: 9 }, (_, p) => Array.from({ length: 8 }, (_, bit) => {
    const q = reserve('gray_storage', true); set(q, `K(${core.outputs[bit]})J(${selectors[p]})K(${core.outputs[bit]})`); return q;
  }));
  // All business nodes have lower numeric IDs than delay nodes. This keeps
  // each chain task last at its FIFO wave, including the final phase task.
  const delayCount = core.depth + delayAdjustment;
  assert(Number.isInteger(delayCount) && delayCount >= 0);
  const delays = []; set(phases[0], `K(${completion_counter})K1`);
  for (let p = 0; p < 8; p++) {
    let prev = phases[p]; const ids = [];
    for (let d = 0; d < delayCount; d++) {
      const q = reserve(d === 0 ? 'delay_anchor' : 'delay_copy');
      set(q, d === 0 ? `J0J(${prev})K1` : `J0K(${prev})`); ids.push(q); prev = q;
    }
    // delayAdjustment exists only for explicit negative tests; a zero length
    // would read a phase value, so it is not a valid optimized architecture.
    set(phases[p + 1], `K(${prev})`); delays.push(ids);
  }
  const model = createSnapshot({ name: '3x3 RGB → gray · shared core · JKRD V4.0.0', input_bits: 216,
    nodes, initial_q, q_y: outputs.flat().map((q, i) => ({ ['Y' + i]: q })), ...(created_at ? { created_at } : {}) });
  const compiled = compileModel(model), counts = new Map(nodes.map(n => [n.id, 0]));
  inputs.forEach(id => counts.set(id, 1));
  for (const group of arrival_groups) {
    group.counter_ids.forEach((id, i) => counts.set(id, group.event_count / (2 ** i)));
    if (group.bridge) counts.set(group.bridge, 1);
  }
  counts.set(padding, weighted_inputs.length); counts.set(ready, 1); phases.forEach(id => counts.set(id, 1)); delays.flat().forEach(id => counts.set(id, 1));
  [...selectors, ...selected_rgb, ...core.nodes.map(n => n.id), ...outputs.flat()].forEach(id => counts.set(id, 9));
  const roles = { inputs, arrival_groups, ready, completion_counter, padding, weighted_inputs, phases, delays, selectors, selected_rgb, core: core.nodes.map(n => n.id), gray_bits: core.outputs, outputs };
  const expected = { executions_per_frame: [...counts.values()].reduce((a, b) => a + b, 0),
    operations_per_frame: nodes.reduce((sum, n) => sum + counts.get(n.id) * parseExpression(n.ex).length, 0),
    output_events_per_bit: 9, initialization_executions: 0, core_executions_per_node: 9 };
  const identity = { md5: model.md5, format_md5: model.format_md5 };
  const spec = { schema: 'rgb-gray-v4-spec-1', rule_version: 'V4.0.0', model: identity,
    formula: 'floor((77*R + 150*G + 29*B + 128)/256)',
    input_encoding: { pixels: 9, channels: ['R', 'G', 'B'], bits_per_channel: 8, bit_order: 'LSB first', index: '24*p + 8*c + b; p=0..8,c=0..2,b=0..7' },
    storage_name_aliases: Object.fromEntries(inputs.map((q, i) => [q, `${q}L${Math.floor(i / 24) + 1}${['R', 'G', 'B'][Math.floor(i / 8) % 3]}${i % 8}`])),
    output_encoding: 'Y(8*p+b) is bit b of pixel p grayscale; L1..L9 row-major',
    protocol: { each_input_exactly_once: true, partial_input_allowed: true, arbitrary_order_allowed: true,
      overlap_frames_allowed: false, within_frame_duplicate_inputs_supported: false,
      completion: 'All 216 inputs supplied exactly once AND Xi.FIFO and Qi.FIFO empty; retain latest event for each Yi.',
      no_extra_clock_or_control_input: true, initialization: 'No tasks or outputs on loading.' },
    roles, expected, per_node_executions: Object.fromEntries(counts),
    scheduling: { shared_core_depth: core.depth, delay_nodes_per_gap: delayCount, gaps: 8,
      phase_to_last_gray_depth: core.depth + 2, phase_to_last_output_depth: core.depth + 3,
      next_phase_depth: delayCount + 1, next_selector_depth: delayCount + 2,
      proof: 'Selectors enqueue before the first delay. By FIFO wave induction every business task at wave k precedes its chain task. With D delay nodes, old gray results at wave D+2 arrive before the next selectors at the same wave; old output tasks lock their previous selector and gray data. Next RGB tasks at D+3 execute after all old output tasks. Every core node completes before the next selected RGB wave. State changes in the phase chain do not alter already latched stateless data.',
      limitation: 'This ordering relies on the declared model topology, numeric ID ordering, no overlapping frames, and stateless data/selector sources. It is not a general arbitrary-graph pacing theorem.' },
    snapshot_boundary: 'Complete input, padding and counters finished, only the first pixel phase queued and all arrival caches empty: resumable without Xi. Arbitrary partial-input or middle-of-round snapshots are not promised to continue equivalently.' };
  const coreAudits = new Map(core.audit.node_audit.map(n => [n.id, n]));
  const minimumFor = n => {
    const kind = role.get(n.id);
    if (coreAudits.has(n.id)) return coreAudits.get(n.id).minimum;
    if (kind === 'inactive_selector') return { proven: true, operations: parseExpression(n.ex).length,
      scope: 'Fixed nine phase sources, stateless EX, independent phase values',
      proof: n.id === selectors[8] ? 'Nine required source occurrences plus mandatory J0 = 10.' : 'Nine required source occurrences plus mandatory J0 and K1 (function is 1 when all sources are zero) = 11.' };
    if (kind === 'gray_storage') return { proven: true, operations: 3, scope: 'Independent old q, gray bit, inactive bit; exact source-mask BFS in preassembly.' };
    if (kind === 'pixel_phase') return { proven: true, operations: n.id === ready ? 2 : 1,
      scope: n.id === ready ? 'Completion source stays zero before this execution; one source operation alone cannot invert old q.' : 'Stateless trigger is constant one; one operation is the nonempty EX lower bound.' };
    if (kind === 'delay_copy') return { proven: true, operations: 2, scope: 'Stateless J0 plus one mandatory source occurrence.' };
    if (kind === 'delay_anchor') return { proven: true, operations: 3, scope: 'Stateless J0, source occurrence and K1 needed to produce one even when source is zero.' };
    if (kind === 'input') return { proven: true, operations: 2, scope: 'Exact V4-mandated input-copy expression.' };
    return { proven: false, scope: 'Template truth/structural proof and event requirements checked; unrestricted shortest search not completed.' };
  };
  const node_audit = compiled.nodes.map(n => ({ id: n.id, role: role.get(n.id), stateful: n.initial !== null,
    initial_q: n.initial, pro: n.pro, sources: n.sources, event_sources: n.eventSources, stateless_barrier: n.required,
    ex_before: coreAudits.get(n.id)?.before ?? n.ex, ex_after: n.ex,
    ...(coreAudits.get(n.id)?.conditional_rewire ? { conditional_rewire: coreAudits.get(n.id).conditional_rewire } : {}),
    conclusion: n.input ? 'Fixed V4 input-copy EX; retained' : coreAudits.has(n.id) ? coreAudits.get(n.id).conclusion : 'Retained after template identity, event-interface and scheduling checks',
    minimum: minimumFor(n) }));
  const audit = { schema: 'rgb-gray-v4-optimization-1', passed: delayAdjustment >= 0, model: identity, preassembly,
    arithmetic: core.audit, node_audit, audited_nodes: node_audit.length,
    whole_graph: { dag: true, all_nodes_have_consumers: true, fixed_input_copies: 216, shared_arithmetic_cores: 1,
      core_nodes: core.nodes.length, pixels_per_frame: 9, live_roles: Object.fromEntries([...new Set(role.values())].map(k => [k, [...role.values()].filter(x => x === k).length])),
      dead_node_deletion_candidates: 0,
      stateful_merging: 'Identical-looking phase, delay, output and counter expressions cannot be merged by truth value: their event history, timing, state or output binding differs.',
      delay_removal: 'Chain depth is selected from the final arithmetic DAG; arbitrary deletion invalidates the FIFO separation proof.',
      initialization: 'No bootstrap or pure-constant node; two empty FIFOs.' },
    optimization_objective: 'Prefer fewer JK nodes; separately report static operations and actual per-frame operations.',
    comparisons: { old_feedback_512: { compatible_with_v4: false, reason: 'Multiple-node feedback, Xi references outside input copies, suffix IDs, constant bootstrap and old snapshot/queue format are not V4 designs.' },
      input_barrier: { direct_bridges_nodes: 217, grouped_counter_nodes: 25, padded_counter_nodes: 9,
        tradeoff: 'Padded counting saves nodes but uses more operations and requires exactly one event per input per frame.' },
      core_candidates: core.audit.candidates },
    metrics: { nodes: model.jk_bits, state_bits: initial_q['0'].length + initial_q['1'].length, static_operations: model.ex_operation_sum, ...expected },
    global_optimum_proven: false, unproven: { core_expressions: core.audit.whole_graph_checks.larger_source_nodes_not_proven_shortest,
      whole_network: 'Not exhaustively searched; no claim of globally fewest nodes or minimum runtime operations.' } };
  assert.equal(node_audit.length, model.jk_bits);
  assert(selectors.every(s => Number(s.slice(1)) < Math.min(...delays.flat().map(q => Number(q.slice(1))))));
  return { model, spec, audit, core };
}

export function writeRgbGrayV4(prefix = DEFAULT_PREFIX) {
  const { model, spec, audit } = generateRgbGrayV4();
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const json = JSON.stringify(model, null, 2) + '\n';
  spec.model.file_sha256 = sha256(json); audit.model = { ...spec.model };
  const specJson = JSON.stringify(spec, null, 2) + '\n'; audit.spec_sha256 = sha256(specJson);
  audit.sources = Object.fromEntries(['scripts/rgb-gray-v4.mjs', 'scripts/rgb-gray-v4-core.mjs', 'skills/jk-network-generator/scripts/model.mjs', 'skills/jk-network-generator/scripts/engine.mjs'].map(p => [p, sha256(fs.readFileSync(path.join(ROOT, p)))]));
  const rulePath = path.join(JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/jk-network-generator/references/source.json'))).root, 'docs/JKRD.md');
  audit.rules = { path: rulePath, sha256: sha256(fs.readFileSync(rulePath)), version: 'V4.0.0' };
  fs.writeFileSync(prefix + '.json', json); fs.writeFileSync(prefix + '.spec.json', specJson);
  fs.writeFileSync(prefix + '.optimization.json', JSON.stringify(audit, null, 2) + '\n');
  return { model: prefix + '.json', spec: prefix + '.spec.json', audit: prefix + '.optimization.json', ...audit.metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(writeRgbGrayV4(process.argv[2]), null, 2));
