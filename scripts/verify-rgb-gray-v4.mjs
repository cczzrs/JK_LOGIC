import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModel, JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';
import { assertSeparateFiles } from '../skills/jk-network-generator/scripts/files.mjs';
import { resolveSource } from '../skills/jk-network-generator/scripts/source.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const sha = data => createHash('sha256').update(data).digest('hex');
const selfPath = fileURLToPath(import.meta.url);
const enginePath = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
const modelPath = fileURLToPath(new URL('../skills/jk-network-generator/scripts/model.mjs', import.meta.url));
const gray = rgb => Math.floor((77 * rgb[0] + 150 * rgb[1] + 29 * rgb[2] + 128) / 256);
const bitsOf = pixels => pixels.flatMap(pixel => pixel.flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >>> bit) & 1)));
const pixelsOf = bits => Array.from({ length: 9 }, (_, p) => Array.from({ length: 3 }, (_, c) => Array.from({ length: 8 }, (_, b) => bits[p * 24 + c * 8 + b] << b).reduce((a, b) => a | b, 0)));
const constantPixels = rgb => Array.from({ length: 9 }, () => [...rgb]);

export function validateRgbGrayV4(raw, spec) {
  const model = compileModel(raw), r = spec?.roles;
  check(spec?.rule_version === 'V4.0.0', 'Specification must declare V4.0.0');
  check(spec.model?.md5 === raw.md5 && spec.model?.format_md5 === raw.format_md5, 'Specification fingerprint mismatch');
  check(raw.input_bits === 216 && raw.output_bits === 72, 'Expected 216 input and 72 output bits');
  check(Object.values(raw.FIFOS).every(queue => queue.length === 0), 'Fresh model must have empty FIFOS');
  check(r && r.inputs?.length === 216 && Array.isArray(r.arrival_groups) && r.phases?.length === 9 && r.delays?.length === 8 && r.selectors?.length === 9 && r.selected_rgb?.length === 24 && r.gray_bits?.length === 8 && r.outputs?.length === 9 && r.outputs.every(x => x.length === 8), 'Invalid role inventory');
  check(r.inputs.every((id, i) => id === `Q${i}`), 'Input roles must preserve Q0..Q215');
  if (r.padding) {
    check(r.arrival_groups.length === 1 && r.arrival_groups[0].input_ids.length === 216 && r.arrival_groups[0].counter_ids.length === 8 && r.arrival_groups[0].event_count === 256 && r.arrival_groups[0].bridge === null, 'Invalid padded 256-event counter');
    check(r.weighted_inputs?.length === 40 && new Set(r.weighted_inputs).size === 40 && r.weighted_inputs.every(id => r.inputs.includes(id)), 'Padding must add one event for 40 different input copies');
    check(r.ready === r.phases[0] && r.completion_counter === r.arrival_groups[0].counter_ids.at(-1), 'Padded counter completion must trigger the first phase');
  } else {
    check(r.arrival_groups.map(g => g.input_ids.length).join(',') === '128,64,16,8', 'Unexpected arrival group sizes');
    for (const g of r.arrival_groups) check(g.counter_ids.length === Math.log2(g.input_ids.length), 'Arrival counter width mismatch');
  }
  check(r.arrival_groups.flatMap(g => g.input_ids).join(',') === r.inputs.join(','), 'Arrival groups must partition all input copies');
  const groups = [r.inputs, r.arrival_groups.flatMap(g => [...g.counter_ids, ...(g.bridge ? [g.bridge] : [])]), ...(r.padding ? [[r.padding]] : [[r.ready]]), r.phases, r.delays.flat(), r.selectors, r.selected_rgb, r.core, r.outputs.flat()];
  const roleNodes = groups.flat();
  check(roleNodes.length === raw.nodes.length && new Set(roleNodes).size === raw.nodes.length && roleNodes.every(id => model.byId.has(id)), 'Roles must partition every model node exactly once');
  check(r.gray_bits.every(id => r.core.includes(id)), 'Gray bits must belong to the shared core');
  check(model.outputs.every((o, i) => o.source === r.outputs.flat()[i]), 'Output mapping mismatch');
  const saved = [...r.inputs, ...r.arrival_groups.flatMap(g => g.counter_ids), ...(r.padding ? [r.padding] : []), ...r.phases, ...r.outputs.flat()];
  const savedSet = new Set(saved);
  check(model.nodes.every(n => (n.initial !== null) === savedSet.has(n.id)), 'Unexpected node state classification');
  check(saved.every(id => model.byId.get(id)[0].initial === Number(id === r.padding)), 'Unexpected saved-state initial value');
  check(r.arrival_groups.flatMap(g => g.counter_ids).every(id => model.byId.get(id)[0].pro === 'q=0'), 'Arrival counters must publish on q=0');
  check([r.ready, ...r.phases, ...r.delays.flat(), ...r.selectors, ...r.selected_rgb, ...r.core, ...r.outputs.flat()].every(id => model.byId.get(id)[0].pro === 'q=0/1'), 'Data and phase roles must publish both values');
  check(Number.isInteger(spec.expected?.executions_per_frame) && spec.expected.executions_per_frame > 0 && Number.isInteger(spec.expected?.operations_per_frame) && spec.expected.operations_per_frame > 0 && spec.expected.output_events_per_bit === 9, 'Invalid expected frame metrics');
  check(spec.per_node_executions && Object.keys(spec.per_node_executions).length === raw.nodes.length && raw.nodes.every(n => Number.isInteger(spec.per_node_executions[n.id]) && spec.per_node_executions[n.id] > 0), 'Missing expected execution count for every node');
  return model;
}

/** Model-specific FIFO verification. The independent oracle is the integer RGB
 * formula; role metadata only identifies observations, never computes results. */
export function verifyRgbGrayV4(raw, spec, { samples = 10000, edges = true, seed = 0x57a19403 } = {}) {
  const coverage = { random_frames: 0, edge_frames: 0, repeated_frames: 0, partial_frames: 0, missing_completion_frames: 0, reset_frames: 0, safe_snapshot_frames: 0, safe_snapshot_replayed_suffixes: 0 };
  const observations = { executions: 0, operations: 0, task_parameter_checks: 0, queue_priority_checks: 0, input_copy_checks: 0, phase_checks: 0, selector_checks: 0, selected_input_checks: 0, output_transition_checks: 0, output_events: 0, peak_queue: 0, peak_input_queue: 0, peak_compute_queue: 0 };
  let phase = 'validation', counterexample = null, completed = 0, baseReport;
  const started = performance.now();
  try {
    check(Number.isInteger(samples) && samples >= 0 && samples <= 1000000, 'samples must be 0..1000000');
    const model = validateRgbGrayV4(raw, spec), r = spec.roles, source = resolveSource();
    baseReport = { verifier: 'rgb-gray-v4-fifo-v1', model: { md5: raw.md5, format_md5: raw.format_md5 }, rule_version: 'V4.0.0', rule: { path: source.rules, sha256: sha(readFileSync(source.rules)) }, implementation: { verifier_sha256: sha(readFileSync(selfPath)), engine_sha256: sha(readFileSync(enginePath)), model_validator_sha256: sha(readFileSync(modelPath)) } };
    const outputIds = r.outputs.flat();
    const inputIndex = new Map(r.inputs.map((id, i) => [id, i])), phaseIndex = new Map(r.phases.map((id, i) => [id, i]));
    const selectorIndex = new Map(r.selectors.map((id, i) => [id, i])), selectedIndex = new Map(r.selected_rgb.map((id, i) => [id, i]));
    const grayIndex = new Map(r.gray_bits.map((id, i) => [id, i])), outputIndex = new Map(outputIds.map((id, i) => [id, i]));
    const counters = new Set(r.arrival_groups.flatMap(g => g.counter_ids)), core = new Set(r.core), delays = new Set(r.delays.flat());
    const bridges = new Set(r.arrival_groups.map(g => g.bridge).filter(Boolean));
    let rng = seed >>> 0;
    const random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
    const randomPixels = () => Array.from({ length: 9 }, () => Array.from({ length: 3 }, () => Math.floor(random() * 256)));
    const engine = new JKEngine(model, { historyLimit: 0 });
    check(engine.length === 0 && engine.total === 0 && [...engine.outputs.values()].every(x => x === null), 'Initialization must not execute or emit outputs');

    function begin(e, pixels, label) {
      check(e.length === 0 && [...e.cache.values()].every(x => x.size === 0), 'Frame must begin at empty queues and arrival collections');
      check(counters.size > 0 && [...counters].every(id => e.q.get(id) === 0), 'Arrival counters did not return to zero');
      if (r.padding) check(e.q.get(r.padding) === 1, 'Padding source must retain one');
      const parity = e.q.get(r.phases[0]);
      check(r.phases.every(id => e.q.get(id) === parity), 'Phase states must agree at idle');
      return { pixels, bits: bitsOf(pixels), wanted: pixels.map(gray), label, submitted: new Set(), counts: new Map(), outputs: Array(72).fill(0), savedOutput: outputIds.map(id => e.q.get(id)), parity, ready: 0, phases: 0, inputCopies: 0, operations: 0, executions: 0 };
    }
    function submit(e, c, indices) {
      const data = {};
      for (const i of indices) { check(!c.submitted.has(i), `Protocol duplicate Xi in frame: X${i}`); c.submitted.add(i); data[`X${i}`] = c.bits[i]; }
      e.send(data);
    }
    function trackStep(e, c) {
      const item = e.itemAt(0), inputQueue = e.queueLength('Xi.FIFO');
      check(item, 'Unexpected empty step');
      observations.peak_queue = Math.max(observations.peak_queue, e.length);
      observations.peak_input_queue = Math.max(observations.peak_input_queue, inputQueue);
      observations.peak_compute_queue = Math.max(observations.peak_compute_queue, e.queueLength('Qi.FIFO'));
      const event = e.step(), n = item.node;
      observations.queue_priority_checks++;
      check(event.queue === (inputQueue > 0 ? 'Xi.FIFO' : 'Qi.FIFO'), 'Wrong FIFO priority');
      check(event.type === 'execution', `Unexpected skipped task ${n.id}`);
      check(++c.executions <= spec.expected.executions_per_frame, 'Frame exceeds expected execution count');
      c.operations += event.operations.length;
      observations.executions++; observations.operations += event.operations.length;
      const round = c.counts.get(n.id) ?? 0;
      c.counts.set(n.id, round + 1);
      for (const sourceId of n.sources) {
        const expected = sourceId.startsWith('X') ? e.x.get(sourceId) : sourceId === n.id ? event.before : e.q.has(sourceId) ? e.q.get(sourceId) : item.values[sourceId];
        check(event.reads[sourceId] === expected, `Incorrect fixed parameter ${sourceId} at ${n.id}`);
        observations.task_parameter_checks++;
      }
      if (inputIndex.has(n.id)) {
        const i = inputIndex.get(n.id);
        check(c.ready === 0 && round === 0 && c.submitted.has(i) && event.value === c.bits[i], `Input copy ${n.id} changed outside its once-per-frame copy`);
        c.inputCopies++; observations.input_copy_checks++;
      } else if (n.id === r.padding) {
        check(event.before === 1 && event.value === 1 && event.published, 'Padding node must always publish one');
      } else if (counters.has(n.id)) {
        check(event.value === (event.before ^ 1) && event.published === (event.value === 0), `Counter toggle/filter mismatch ${n.id}`);
      } else if (bridges.has(n.id)) {
        check(round === 0 && event.value === 1, `Arrival bridge ${n.id} must fire once with one`);
      } else if (n.id === r.ready && !phaseIndex.has(n.id)) {
        check(++c.ready === 1 && c.submitted.size === 216 && c.inputCopies === 216 && event.value === 1, 'Ready fired before all input copies or more than once');
        check([...counters].every(id => e.q.get(id) === 0), 'Ready fired with nonzero arrival counters');
      } else if (phaseIndex.has(n.id)) {
        const p = phaseIndex.get(n.id);
        if (n.id === r.ready) {
          check(++c.ready === 1 && c.submitted.size === 216 && c.inputCopies === 216, 'First phase fired before all input copies or more than once');
          check([...counters].every(id => e.q.get(id) === 0), 'First phase fired with nonzero arrival counters');
        }
        check(c.ready === 1 && p === c.phases++ && round === 0 && event.value === (c.parity ^ 1), `Phase ${n.id} out of sequence`);
        check(r.phases.every((id, i) => e.q.get(id) === (i <= p ? c.parity ^ 1 : c.parity)), 'Phase prefix invariant violated');
        check(r.inputs.every((id, i) => e.q.get(id) === c.bits[i]), 'Saved RGB changed during computation');
        observations.phase_checks++;
      } else if (selectorIndex.has(n.id)) {
        const s = selectorIndex.get(n.id);
        check(round < 9 && event.value === (s === round ? 0 : 1), `Inactive selector ${n.id} wrong at round ${round}`);
        if (round > 0) check(r.gray_bits.every(id => (c.counts.get(id) ?? 0) >= round), 'Next selector arrived before prior gray outputs were all published');
        observations.selector_checks++;
      } else if (selectedIndex.has(n.id)) {
        const b = selectedIndex.get(n.id);
        check(round < 9 && event.value === c.bits[round * 24 + b], `Selected RGB ${n.id} wrong at round ${round}`);
        if (round > 0) check(outputIds.every(id => (c.counts.get(id) ?? 0) >= round), 'Next selected RGB began before all prior saved outputs completed');
        observations.selected_input_checks++;
      } else if (outputIndex.has(n.id)) {
        const o = outputIndex.get(n.id), pixel = Math.floor(o / 8), bit = o % 8;
        check(round < 9 && event.before === c.savedOutput[o], `Output state ${n.id} changed unexpectedly`);
        const incoming = (c.wanted[round] >>> bit) & 1;
        check(event.reads[r.selectors[pixel]] === (pixel === round ? 0 : 1) && event.reads[r.gray_bits[bit]] === incoming, `Output ${n.id} used mismatched locked selector/data`);
        const wanted = pixel === round ? incoming : c.savedOutput[o];
        check(event.value === wanted, `Output ${n.id} next-state oracle failed`);
        c.savedOutput[o] = wanted; observations.output_transition_checks++;
      }
      if (core.has(n.id)) check(round < 9, `Shared core ${n.id} executed more than nine times`);
      if (grayIndex.has(n.id)) check(event.value === ((c.wanted[round] >>> grayIndex.get(n.id)) & 1), `Gray arithmetic ${n.id} wrong at round ${round}`);
      if (delays.has(n.id)) check(round === 0 && event.value === 1, `Delay ${n.id} must publish once with one`);
      for (const transfer of event.transfers) if (transfer.target.startsWith('Y')) {
        const o = Number(transfer.target.slice(1));
        check(transfer.source === outputIds[o] && transfer.value === c.savedOutput[o], `Wrong output event ${transfer.target}`);
        c.outputs[o]++; observations.output_events++;
      }
      return event;
    }
    function drain(e, c) { while (e.length) trackStep(e, c); }
    function finish(e, c, category) {
      check(c.submitted.size === 216 && c.inputCopies === 216 && c.ready === 1 && c.phases === 9, 'Incomplete frame');
      check(c.executions === spec.expected.executions_per_frame && c.operations === spec.expected.operations_per_frame, `Frame metrics mismatch: ${c.executions} executions / ${c.operations} operations`);
      check(model.nodes.every(n => c.counts.get(n.id) === spec.per_node_executions[n.id]), 'Per-node execution count mismatch');
      check(r.core.every(id => c.counts.get(id) === 9), 'Shared core must execute exactly nine times');
      check(c.outputs.every(n => n === 9) && outputIds.every(id => c.counts.get(id) === 9), 'Every output bit must execute and publish nine times');
      for (let i = 0; i < 72; i++) check(e.outputs.get(`Y${i}`) === ((c.wanted[Math.floor(i / 8)] >>> (i % 8)) & 1), `Final Y${i} mismatch`);
      check(r.inputs.every((id, i) => e.q.get(id) === c.bits[i]), 'Saved input mismatch');
      check(e.length === 0 && [...e.cache.values()].every(x => x.size === 0), 'Frame leaves pending work or arrivals');
      check([...counters].every(id => e.q.get(id) === 0) && r.phases.every(id => e.q.get(id) === (c.parity ^ 1)), 'Idle state not reestablished');
      coverage[category]++; completed++; counterexample = null;
    }
    const all = Array.from({ length: 216 }, (_, i) => i);
    function run(pixels, category, label = category) {
      const c = begin(engine, pixels, label); counterexample = { label, pixels, expected: c.wanted };
      submit(engine, c, all); drain(engine, c); finish(engine, c, category);
    }
    phase = 'edges';
    if (edges) {
      for (let value = 0; value < 256; value++) run(constantPixels([value, value, value]), 'edge_frames', `gray-${value}`);
      for (const rgb of [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[255,0,255],[0,255,255]]) run(constantPixels(rgb), 'edge_frames', `color-${rgb}`);
      for (let bit = 0; bit < 216; bit++) { const bits = Array(216).fill(0); bits[bit] = 1; run(pixelsOf(bits), 'edge_frames', `single-one-${bit}`); }
      for (let bit = 0; bit < 216; bit++) { const bits = Array(216).fill(1); bits[bit] = 0; run(pixelsOf(bits), 'edge_frames', `single-zero-${bit}`); }
    }
    phase = 'random';
    for (let i = 0; i < samples; i++) run(randomPixels(), 'random_frames', `random-${i}`);
    phase = 'repeated';
    for (let i = 0; i < 4; i++) { const pixels = randomPixels(); run(pixels, 'repeated_frames'); run(pixels, 'repeated_frames'); }
    phase = 'partial';
    for (let frame = 0; frame < 12; frame++) {
      const c = begin(engine, randomPixels(), `partial-${frame}`), order = [...all];
      counterexample = { label: c.label, pixels: c.pixels, expected: c.wanted };
      for (let i = 215; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (let start = 0; start < 216;) {
        const end = Math.min(216, start + 1 + Math.floor(random() * 23)); submit(engine, c, order.slice(start, end)); start = end;
        if (frame % 2 === 0) drain(engine, c);
        else { let steps = Math.floor(random() * 12); while (steps-- && engine.length) trackStep(engine, c); }
        if (start < 216) check(c.ready === 0 && c.outputs.every(x => x === 0), 'Partial input produced premature frame output');
      }
      drain(engine, c); finish(engine, c, 'partial_frames');
    }
    phase = 'missing';
    for (const missing of all) {
      const c = begin(engine, randomPixels(), `missing-X${missing}`); counterexample = { label: c.label, pixels: c.pixels, expected: c.wanted };
      submit(engine, c, all.filter(i => i !== missing)); drain(engine, c);
      check(c.ready === 0 && c.outputs.every(x => x === 0), 'Missing input must block computation');
      submit(engine, c, [missing]); drain(engine, c); finish(engine, c, 'missing_completion_frames');
    }
    phase = 'reset';
    engine.reset(); run(randomPixels(), 'reset_frames', 'reset-idle');
    const partial = begin(engine, randomPixels(), 'discarded-partial'); submit(engine, partial, all.slice(0, 130)); drain(engine, partial); engine.reset();
    check(engine.length === 0 && engine.x.size === 0 && [...engine.cache.values()].every(c => c.size === 0) && [...engine.outputs.values()].every(q => q === null), 'Reset did not restore fresh runtime');
    run(randomPixels(), 'reset_frames', 'reset-after-partial');
    phase = 'safe-snapshot';
    const c = begin(engine, randomPixels(), 'safe-ready-snapshot'); counterexample = { label: c.label, pixels: c.pixels, expected: c.wanted }; submit(engine, c, all);
    while (engine.length && engine.itemAt(0).node.id !== r.ready) trackStep(engine, c);
    check(engine.length === 1 && engine.itemAt(0).node.id === r.ready && [...engine.cache.values()].every(x => x.size === 0), 'Safe Ready snapshot boundary not reached');
    const saved = engine.snapshot(), restored = new JKEngine(compileModel(JSON.parse(JSON.stringify(saved))), { historyLimit: 0 });
    check(restored.x.size === 0 && restored.length === 1 && restored.itemAt(0).node.id === r.ready, 'Snapshot must restore Ready task without external Xi');
    const replay = structuredClone(c);
    const trace = e => ({ node: e.node, queue: e.queue, before: e.before, value: e.value, reads: e.reads, operations: e.operations, published: e.published, transfers: e.transfers });
    while (engine.length || restored.length) {
      check(engine.length === restored.length, 'Snapshot queue lengths diverged');
      const a = trackStep(engine, c), b = trackStep(restored, replay);
      check(JSON.stringify(trace(a)) === JSON.stringify(trace(b)), 'Safe snapshot continuation trace differs');
    }
    finish(engine, c, 'safe_snapshot_frames');
    check(replay.outputs.every(n => n === 9) && [...restored.q].every(([id, q]) => engine.q.get(id) === q) && [...restored.cache.values()].every(x => x.size === 0), 'Safe snapshot final state differs');
    coverage.safe_snapshot_replayed_suffixes++;
    return { ...baseReport, passed: true, verified_at: new Date().toISOString(), elapsed_seconds: (performance.now() - started) / 1000, random_seed: seed >>> 0, completed_frames: completed, coverage, metrics: { nodes: raw.jk_bits, saved_states: model.nodes.filter(n => n.initial !== null).length, static_operations: raw.ex_operation_sum, initialization_executions: 0, executions_per_frame: spec.expected.executions_per_frame, operations_per_frame: spec.expected.operations_per_frame, output_events_per_bit_per_frame: 9, ...observations }, snapshot: { checked_boundary: r.padding ? 'All input copies and padded counter tasks complete; sole queued first-phase task; empty arrival collections' : 'All input copies complete; sole queued Ready task holds all four bridge values; empty arrival collections', continuation_trace_equal: true, arbitrary_checkpoint_continuity_proven: false, excluded_fields: ['external Xi current values', 'uncollected stateless-source arrival collections', 'external Yi event history'] }, boundary: 'Exactly one event per Xi per frame; arbitrary unique order and partition, with both FIFOs drained before the next frame. Duplicate or overlapping frames are not supported by this application protocol. Arithmetic checked against independent integer oracle; no global-optimality claim.' };
  } catch (error) {
    error.report = { ...baseReport, verifier: 'rgb-gray-v4-fifo-v1', passed: false, phase, error: error.message, counterexample, completed_frames: completed, coverage, metrics: observations, elapsed_seconds: (performance.now() - started) / 1000 };
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let reportPath, writable = false;
  try {
    const args = process.argv.slice(2), positionals = [], options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--samples') { options.samples = Number(args[++i]); check(Number.isInteger(options.samples), 'Invalid --samples'); }
      else if (args[i] === '--no-edges') options.edges = false;
      else { check(!args[i].startsWith('--'), `Unknown option ${args[i]}`); positionals.push(args[i]); }
    }
    check(positionals.length >= 1 && positionals.length <= 2, 'Usage: node verify-rgb-gray-v4.mjs MODEL.json [REPORT.json] [--samples N] [--no-edges]');
    const inputPath = resolve(positionals[0]), specPath = inputPath.replace(/\.json$/, '.spec.json');
    reportPath = resolve(positionals[1] ?? inputPath.replace(/\.json$/, '.verification.json'));
    check(inputPath.endsWith('.json'), 'Model file must end in .json');
    assertSeparateFiles(inputPath, reportPath); assertSeparateFiles(specPath, reportPath); writable = true;
    const modelBytes = readFileSync(inputPath), specBytes = readFileSync(specPath), spec = JSON.parse(specBytes);
    check(spec.model?.file_sha256 === sha(modelBytes), 'Specification does not bind the final model file SHA-256');
    const report = verifyRgbGrayV4(JSON.parse(modelBytes), spec, options);
    report.files = { model: { path: inputPath, sha256: sha(modelBytes) }, specification: { path: specPath, sha256: sha(specBytes) } };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, report: reportPath, model: report.model, completed_frames: report.completed_frames, elapsed_seconds: report.elapsed_seconds, metrics: report.metrics }));
  } catch (error) {
    if (writable) {
      const report = error.report ?? { verifier: 'rgb-gray-v4-fifo-v1', passed: false, phase: 'file-validation', error: error.message };
      try { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
      catch (writeError) { console.error(`Could not write failed report: ${writeError.message}`); }
    }
    console.error(error.message); process.exitCode = 1;
  }
}
