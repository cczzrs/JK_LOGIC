import { Builder, digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';
import { parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';
import { optimizeSharedExpressions, validateSharedBuildingBlocks } from './ex-rewrites.mjs';
import { auditModels } from './audit-rgb-gray-ex.mjs';

const CHANNELS = ['R', 'G', 'B'];
const COEFFICIENTS = [77, 150, 29];
const hashContract = 'md5 = lowercase MD5 of UTF-8 recursively key-sorted JSON of {nodes, initial_q, q_y, spec}; array order retained';

// Keep these arithmetic choices local: the existing parallel generator and the
// skill's general-purpose Builder retain their original behavior.
class SharedGrayBuilder extends Builder {
  mux(s, a, b) {
    if (typeof s === 'number') return s ? b : a;
    if (a === b) return a;
    return this.emit('J0' + this.token('K', a) + this.token('K', b)
      + this.token('J', s) + this.token('K', a));
  }
  fullAdder(a, b, c) {
    if ([a, b, c].some(x => typeof x === 'number')) return super.fullAdder(a, b, c);
    const parity = this.xor(a, b);
    return [this.xor(parity, c), this.mux(parity, a, c)];
  }
}

function checkedBuildingBlocks() {
  const primitive = build => {
    const builder = new SharedGrayBuilder(true), outputs = build(builder);
    return { nodes: builder.nodes, initial_q: { '0': [], '1': [] },
      q_y: outputs.map((source, i) => ({ [`Y${i}`]: source })) };
  };
  return validateSharedBuildingBlocks({
    xor: primitive(b => [b.xor('X0', 'X1')]),
    mux: primitive(b => [b.mux('X0', 'X1', 'X2')]),
    full_adder: primitive(b => b.fullAdder('X0', 'X1', 'X2')),
  });
}

/** One stateless, fixed-coefficient grayscale core, with 24 virtual Xi inputs. */
export function sharedPixelCore() {
  // Run the primitive function, minimum-length and FIFO checks before the first
  // arithmetic block is composed or copied. Subsequent calls use the cache.
  checkedBuildingBlocks();
  const builder = new SharedGrayBuilder(true);
  const columns = Array.from({ length: 17 }, () => []);
  for (let c = 0; c < 3; c++) {
    for (let shift = 0; shift < 8; shift++) if ((COEFFICIENTS[c] >> shift) & 1) {
      for (let b = 0; b < 8; b++) columns[b + shift].push(`X${c * 8 + b}`);
    }
  }
  columns[7].push(1);
  for (let weight = 0; weight < 16; weight++) {
    while (columns[weight].length > 2) {
      const [sum, carry] = builder.fullAdder(...columns[weight].splice(0, 3));
      columns[weight].push(sum);
      columns[weight + 1].push(carry);
    }
  }
  const outputs = builder.add(
    columns.slice(0, 16).map(c => c[0] ?? 0),
    columns.slice(0, 16).map(c => c[1] ?? 0), 16,
  ).slice(8, 16);

  const byId = new Map(builder.nodes.map(n => [n.id, n]));
  const live = new Set();
  function visit(id) {
    if (typeof id !== 'string' || !id.startsWith('Q') || live.has(id)) return;
    live.add(id);
    for (const t of parseExpression(byId.get(id).ex)) if (t.source) visit(t.source);
  }
  outputs.forEach(visit);
  const nodes = builder.nodes.filter(n => live.has(n.id))
    .map(n => ({ ...n, tokens: parseExpression(n.ex) }));
  const retainedOutputs = new Set(outputs);
  const beforeInlining = nodes.length;

  // Inline only complete JK expressions for which accumulator substitution is
  // valid. XOR-only children can be inserted at a K; AND-only children at a J.
  // Any child may replace the first K following the stateless J0 reset.
  for (;;) {
    let removed = 0;
    for (let i = 0; i < nodes.length; i++) {
      const child = nodes[i];
      if (retainedOutputs.has(child.id)) continue;
      const consumers = nodes.filter(n => n.tokens.some(t => t.source === child.id));
      if (!consumers.length) { nodes.splice(i--, 1); removed++; continue; }
      const xorOnly = child.tokens.slice(1).every(t => t.op === 'K');
      const andOnly = child.tokens[1]?.op === 'K'
        && child.tokens.slice(2).every(t => t.op === 'J');
      const safe = consumers.every(n => n.tokens.every((t, j) => t.source !== child.id
        || (t.op === 'K' && (xorOnly || j === 1)) || (t.op === 'J' && andOnly)));
      if (!safe) continue;
      for (const n of consumers) n.tokens = n.tokens.flatMap(t => t.source !== child.id
        ? [t] : t.op === 'K' ? child.tokens.slice(1)
          : child.tokens.slice(1).map(x => ({ ...x, op: 'J' })));
      nodes.splice(i--, 1); removed++;
    }
    if (!removed) break;
  }
  return {
    nodes: nodes.map(n => ({ id: n.id, ex: n.tokens.map(t => t.source
      ? `${t.op}(${t.source})` : `${t.op}${t.constant}`).join('') })),
    outputs, before_inlining: beforeInlining,
  };
}

/** A complete, internally clocked nine-pixel model under the unchanged FIFO engine. */
export function generateUnoptimizedRgbGrayShared({ profile = 'pixel-suffixed', createdAt = new Date().toISOString() } = {}) {
  if (!['pixel-suffixed', 'numeric-compatibility'].includes(profile)) throw new Error('Unknown ID profile');
  const storage = Array.from({ length: 216 }, (_, i) => profile === 'numeric-compatibility'
    ? `Q${i}` : `Q${i}L${Math.floor(i / 24) + 1}${CHANNELS[Math.floor(i / 8) % 3]}${i % 8}`);
  const core = sharedPixelCore();
  if (core.nodes.length !== 168) throw new Error(`Shared core changed: expected 168 nodes, got ${core.nodes.length}`);
  const roles = {
    storage, frame_seed: 'Q216', bootstrap: 'Q217', clock: 'Q218',
    merges: Array.from({ length: 9 }, (_, i) => `Q${219 + i}`),
    tokens: Array.from({ length: 9 }, (_, i) => `Q${228 + i}`),
    tick: 'Q237', selector_wrap: 'Q238',
    selector_thresholds: Array.from({ length: 8 }, (_, i) => `Q${246 - i}`),
    selected_inputs: Array.from({ length: 24 }, (_, i) => `Q${247 + i}`),
    core: Array.from({ length: 168 }, (_, i) => `Q${271 + i}`),
    core_outputs: [],
    output_state: Array.from({ length: 72 }, (_, i) => `Q${439 + i}`),
    core_done: 'Q511',
  };
  const nodes = [], initial_q = { '0': [], '1': [] };
  const add = (id, ex, initial) => {
    nodes.push({ id, ex });
    if (initial !== undefined) initial_q[initial].push(id);
  };
  storage.forEach((id, i) => add(id, `J0K(X${i})`, 0));
  // Each Xi queues its storage node before Q216. Consequently the all-X seed
  // executes after the final storage write, including interleaved partial sends.
  add(roles.frame_seed, 'J0' + storage.map((_, i) => `K(X${i})`).join('') + 'J0K1', 0);
  add(roles.bootstrap, 'J0K1', 0);
  add(roles.clock, `J0K(${roles.bootstrap})K(${roles.core_done})J0K1`);
  roles.merges.forEach((id, i) => add(id, `J0K(${roles.frame_seed})`
    + (i ? `K(${roles.tokens[i - 1]})` : '') + 'J0K1'));
  roles.tokens.forEach((id, i) => add(id, `J0K(${roles.merges[i]})K(${roles.clock})J0K1`, 0));
  add(roles.tick, `J0K(${roles.tokens[8]})J0K1`);

  // s[k] is 1 exactly when the selected zero-based pixel index is >= k+1.
  // Numeric target ordering snapshots old s8, then updates s8..s1, then reads
  // the selected RGB bytes. All of those nodes consume the same Tick once.
  add(roles.selector_wrap, `J0K(${roles.tick})J0K(${roles.selector_thresholds[7]})`, 0);
  for (let i = 7; i >= 0; i--) add(roles.selector_thresholds[i],
    `J0K(${roles.tick})J0K(${roles.selector_wrap})K1`
      + (i ? `J(${roles.selector_thresholds[i - 1]})` : ''), 1);
  roles.selected_inputs.forEach((id, b) => {
    let ex = `J0K(${roles.tick})J0K(${storage[8 * 24 + b]})`;
    for (let p = 7; p >= 0; p--) ex += `K(${storage[p * 24 + b]})`
      + `J(${roles.selector_thresholds[p]})K(${storage[p * 24 + b]})`;
    add(id, ex);
  });

  const remap = new Map(core.nodes.map((n, i) => [n.id, roles.core[i]]));
  const mapSource = id => id.startsWith('X') ? roles.selected_inputs[Number(id.slice(1))] : remap.get(id);
  core.nodes.forEach(n => add(remap.get(n.id), parseExpression(n.ex).map(t => t.source
    ? `${t.op}(${mapSource(t.source)})` : `${t.op}${t.constant}`).join('')));
  roles.core_outputs = core.outputs.map(mapSource);
  roles.output_state.forEach((id, i) => {
    const p = Math.floor(i / 8), value = roles.core_outputs[i % 8];
    // q' = q XOR ((q XOR value) AND s[p] AND NOT s[p+1]), s[0]=1,s[9]=0.
    add(id, `J0K(${id})K(${value})`
      + (p < 8 ? `J(${roles.selector_thresholds[p]})` : 'J0')
      + `K(${id})K(${value})`
      + (p > 0 ? `J(${roles.selector_thresholds[p - 1]})` : 'J1') + `K(${id})`, 0);
  });
  // Q511 sorts after every output register; the final result writes precede
  // completion, and the subsequent C starts at most one more arithmetic round.
  add(roles.core_done, 'J0' + roles.core_outputs.map(id => `K(${id})`).join('') + 'J0K1', 0);

  const spec = {
    operation: 'rgb-to-grayscale', architecture_mode: 'shared',
    architecture: '216 persistent input bits, one all-input state barrier, finite nine-token FIFO controller, thermometer selector, one shared stateless grayscale core, 72 conditional output-state bits',
    id_profile: profile,
    required_extensions: profile === 'pixel-suffixed' ? ['pixel-node-id-v1'] : [],
    input_bits: 216, output_bits: 72, signed: false, bit_order: 'LSB-first',
    width: 3, height: 3, channels: CHANNELS,
    pixel_order: 'row-major, L1 is top-left, L9 is bottom-right',
    input_mapping: 'X[24*p + 8*c + b]: p=0..8, c=0:R/1:G/2:B, b=0..7 (LSB=0)',
    output_mapping: 'Y[8*p + b]: p=0..8, b=0..7 (LSB=0)',
    output_encoding: 'nine unsigned 8-bit grayscale pixels in row-major order',
    formula: 'floor((77*R + 150*G + 29*B + 128) / 256)',
    coefficients: COEFFICIENTS, rounding_bias: 128, divisor: 256,
    intermediate_bits: 16, maximum_numerator: 65408,
    rounding: 'nearest integer; exact half rounds up',
    color_processing: 'integer approximation on supplied encoded RGB bytes; no gamma decoding or color-space conversion',
    input_protocol: 'Each frame supplies every X0..X215 exactly once, in one send or disjoint partial sends. Execution may occur between sends. Send no bit of the next frame until the current complete frame FIFO has drained. No overlapping frames or repeated Xi within an incomplete frame. Drain the two initialization events before observing a frame.',
    incomplete_frame: 'Save received bits, retain unsent input-state bits and all previous output values. No new Tick or grayscale output publication occurs until all 216 inputs arrive. Reset may discard an incomplete frame.',
    output_validity: 'Each Yi publishes nine times per complete frame, once per shared-core round, including unchanged values. Only the selected pixel output registers change q. Intermediate publications are not a complete-frame result. Read the final 72-bit output only after a complete frame has supplied all 216 inputs and the FIFO has drained.',
    state_initialization: 'The eight selector thresholds start at 1; all other state q bits start at 0. Bootstrap and clock execute once on initialization, filling the nine token clock slots without any grayscale output publication.',
    state_update: 'Only Xi writes its corresponding saved input q. The feedback loop reads those states without modifying them. Output q is conditionally overwritten in its corresponding pixel round and persists across frames.',
    storage_naming: 'Q{i}L{p+1}{channel}{b}; i=24*p+8*c+b, channel=R/G/B, b=0..7',
    roles,
    execution: {
      initialization_steps: 2, frame_steps: 2791, rounds_per_frame: 9,
      output_publications_per_bit_per_frame: 9,
      input_storage_bits: 216, total_state_bits: initial_q[0].length + initial_q[1].length,
      idle_cache: 'Exactly one clock arrival remains in each of the nine token nodes; every other arrival cache is empty. These nine clock slots are intentionally retained for the next frame.',
      ordering_invariants: [
        'Each storage numeric ID is lower than frame_seed, so all storage writes execute before the all-X barrier.',
        'selector_wrap sorts before thresholds in s8..s1 order; every selector state sorts before selected_inputs.',
        'Every output_state sorts before core_done; core_done requires all eight stateless core output sources.',
      ],
      termination: 'At round r=1..9, only token nodes T[r-1]..T8 have a merge arrival. Clock C consumes those arrivals and those token nodes publish once, replenishing only M[r]..M8. T8 starts one shared-core round, whose completion publishes the next C. Thus the active suffix loses one token per round. After round 9 no merge arrivals remain; C is cached but cannot enqueue any token node, and the FIFO drains. The next frame seeds all nine merge arrivals again.',
    },
    optimization: {
      method: 'One core reused nine times; three-node nonconstant full adders; safe JK-expression inlining; 24 single-node nine-way input selectors; single-node conditional output writes; finite token control; all-X FIFO barrier replaces 216 separate completion nodes.',
      shared_arithmetic_nodes: core.nodes.length,
      arithmetic_nodes_before_inlining: core.before_inlining,
      retained_storage_bits: 216, baseline_parallel_nodes: 4339,
      saved_nodes: 4339 - nodes.length,
      global_minimum_claimed: false,
    },
  };
  if (profile === 'numeric-compatibility') spec.storage_name_aliases = Object.fromEntries(storage.map((id, i) => [id,
    `Q${i}L${Math.floor(i / 24) + 1}${CHANNELS[Math.floor(i / 8) % 3]}${i % 8}`]));
  const raw = {
    name: `3x3 RGB 216-bit saved-input to 72-bit grayscale, shared core (${profile})`,
    format: 'jk-logic-structure-V3.1.0', architecture_mode: 'shared', created_at: createdAt,
    input_bits: 216, output_bits: 72, ...metrics(nodes), nodes, initial_q,
    q_y: roles.output_state.map((id, i) => ({ [`Y${i}`]: id })),
    inputs: Array.from({ length: 216 }, (_, i) => ({ [`X${i}`]: `X${i}` })),
    outputs: Array.from({ length: 72 }, (_, i) => ({ [`Y${i}`]: `Y${i}` })),
    spec, hash_contract: hashContract,
  };
  raw.md5 = digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec });
  return raw;
}

/** Deliver only the fully audited network; retain the raw builder for independent comparison. */
export function generateRgbGrayShared(options = {}) {
  const preassembly = checkedBuildingBlocks();
  const baseline = generateUnoptimizedRgbGrayShared(options);
  const { model, report } = optimizeSharedExpressions(baseline);
  Object.assign(model, metrics(model.nodes));
  model.spec.execution.initialization_operations = report.after_initialization_operations;
  model.spec.execution.frame_operations = report.after_frame_operations;
  model.spec.optimization.preassembly_checks = preassembly;
  model.spec.optimization.ex_optimization = {
    visited_nodes: report.visited_nodes, changed_nodes: report.changed_nodes,
    before_operations: report.before_operations, after_operations: report.after_operations,
    before_initialization_operations: report.before_initialization_operations,
    after_initialization_operations: report.after_initialization_operations,
    before_frame_operations: report.before_frame_operations, after_frame_operations: report.after_frame_operations,
    proof_layers: ['source-preserving universal JK identities', 'checked shared-controller reachable-state invariants'],
    postassembly_checks: report.post_build, selector_invariant_states: report.after_context.selector_transitions,
    nodes_sources_state_and_topology_preserved: true, scope: report.scope,
  };
  model.md5 = digest({ nodes: model.nodes, initial_q: model.initial_q, q_y: model.q_y, spec: model.spec });
  // The standalone auditor imports neither this builder nor the rewrite pass.
  // API callers therefore receive the same independent final-assembly gate as
  // CLI callers, before any model is returned or written to disk.
  const audit = auditModels(baseline, model);
  if (!audit.passed) throw new Error(`Independent assembled-model audit failed: ${audit.error?.message ?? 'unknown failure'}`);
  return model;
}
