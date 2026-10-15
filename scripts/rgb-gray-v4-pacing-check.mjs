/** Targeted proof checks for the V4 grayscale scheduler; no general regression. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateRgbGrayV4 } from './rgb-gray-v4.mjs';
import { compileModel, createSnapshot, createdAt, parseExpression } from '../skills/jk-network-generator/scripts/model.mjs';
import { JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const identity = model => ({ md5: model.md5, format_md5: model.format_md5,
  serialized_sha256: sha256(JSON.stringify(model, null, 2) + '\n') });
const stamp = createdAt(BigInt(Date.parse('2026-10-14T00:00:00Z')) * 1000000n);

function frame(seed) {
  let rng = seed;
  const bits = Array.from({ length: 216 }, () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) >>> 30) & 1);
  const rgb = Array.from({ length: 9 }, (_, p) => Array.from({ length: 3 }, (_, c) =>
    Array.from({ length: 8 }, (_, b) => bits[24 * p + 8 * c + b] << b).reduce((a, b) => a | b, 0)));
  return { seed, bits, rgb, expected: rgb.map(([r, g, b]) => (77 * r + 150 * g + 29 * b + 128) >> 8),
    input: Object.fromEntries(bits.map((b, i) => ['X' + i, b])) };
}

function run(model, spec, f) {
  const engine = new JKEngine(compileModel(model), { historyLimit: 0 });
  const outputCounts = Array(72).fill(0); let firstBad = null, executions = 0;
  engine.send(f.input);
  while (engine.length) {
    const ev = engine.step(); executions++;
    for (const t of ev.transfers.filter(t => t.target.startsWith('Y'))) {
      const y = Number(t.target.slice(1)), p = Math.floor(y / 8), bit = y % 8;
      const round = outputCounts[y]++;
      const expected = p <= round ? (f.expected[p] >> bit) & 1 : 0;
      if (!firstBad && t.value !== expected) firstBad = {
        execution: executions, ticket: ev.ticket, node: ev.node, output: t.target,
        pixel: p + 1, bit, output_event_index: round + 1, expected, observed: t.value,
        before: ev.before, reads: ev.reads,
        selector: spec.roles.selectors[p], gray_source: spec.roles.gray_bits[bit],
      };
    }
  }
  const observed = Array.from({ length: 9 }, (_, p) => Array.from({ length: 8 }, (_, b) =>
    engine.outputs.get('Y' + (8 * p + b)) << b).reduce((a, b) => a | b, 0));
  return { passed: firstBad === null && observed.every((v, i) => v === f.expected[i]),
    first_bad_event: firstBad, observed, executions, output_counts: outputCounts,
    cache_entries: [...engine.cache.values()].reduce((n, c) => n + c.size, 0) };
}

function checkConditionalRewrites(generated) {
  const { model, spec } = generated, roles = spec.roles, nodes = structuredClone(model.nodes);
  const bottom = roles.arrival_groups[0].counter_ids[0], top = roles.completion_counter;
  nodes[Number(bottom.slice(1))].ex = 'J0' + [...roles.inputs, roles.padding].map(q => `J(${q})`).join('') + `K(${bottom})K1`;
  nodes[Number(roles.ready.slice(1))].ex = `K(${top})K(${top})K1`;
  const baseline = createSnapshot({ name: model.name, input_bits: model.input_bits, nodes,
    initial_q: model.initial_q, q_y: model.q_y, created_at: model.created_at });
  const engines = [model, baseline].map(m => new JKEngine(compileModel(m), { historyLimit: 0 }));
  let compared = 0, frames = 0;
  function drain() {
    assert.equal(engines[0].length, engines[1].length);
    while (engines[0].length) {
      const events = engines.map(e => e.step());
      const semantic = e => ({ type: e.type, queue: e.queue, node: e.node,
        before: e.before, value: e.value, published: e.published,
        reads: Object.fromEntries(Object.entries(e.reads).sort()), transfers: e.transfers });
      assert.deepEqual(semantic(events[0]), semantic(events[1]));
      assert.equal(engines[0].q.get(roles.padding), 1);
      if (events[0].node === roles.ready) assert.equal(events[0].reads[top], 0);
      compared++;
    }
  }
  for (let i = 0; i < 20; i++) {
    const f = frame(179 + i);
    if (i % 2 === 0) { for (const e of engines) e.send(f.input); drain(); }
    else for (let bit = 215; bit >= 0; bit--) {
      for (const e of engines) e.send({ ['X' + bit]: f.bits[bit] }); drain();
      if (bit > 0) assert.equal(engines[0].counts.get('node-' + roles.ready.slice(1)), i);
    }
    for (const e of engines) {
      assert(roles.arrival_groups[0].counter_ids.every(q => e.q.get(q) === 0));
      for (let p = 0; p < 9; p++) for (let bit = 0; bit < 8; bit++)
        assert.equal(e.outputs.get('Y' + (8 * p + bit)), (f.expected[p] >> bit) & 1);
    }
    frames++;
  }
  return { passed: true, frames, compared_executions: compared,
    alternating_complete_and_reverse_bitwise_input: true,
    baseline_model: identity(baseline),
    proof_scope: 'Padding starts at 1 and always computes 1. Completion top is 0 after all 256 weighted arrivals; no further frame arrives before calculation drains. Every input occurs exactly once per frame.',
    arbitrary_state_equivalence_claimed: false };
}

function balancedCost(core, inputs) {
  const depths = new Map(inputs.map(q => [q, 0])), copies = new Map();
  for (const n of core.nodes) {
    const sources = [...new Set(parseExpression(n.ex).flatMap(t => t.source ? [t.source] : []))];
    const depth = 1 + Math.max(...sources.map(s => depths.get(s))); depths.set(n.id, depth);
    for (const s of sources) copies.set(s, Math.max(copies.get(s) ?? 0, depth - 1 - depths.get(s)));
  }
  const outputDepths = core.outputs.map(q => depths.get(q));
  return { core_delay_copies: [...copies.values()].reduce((a, b) => a + b, 0),
    output_depths: outputDepths,
    extra_output_alignment_copies: outputDepths.reduce((s, d) => s + core.depth - d, 0),
    scope: 'One level-balanced construction, sharing each source delay prefix. Not a lower bound on all pipeline architectures.' };
}

export function checkPacing() {
  const good = generateRgbGrayV4({ created_at: stamp });
  const short = generateRgbGrayV4({ created_at: stamp, delayAdjustment: -1 });
  const f = frame(179), accepted = run(good.model, good.spec, f), rejected = run(short.model, short.spec, f);
  assert.equal(good.model.jk_bits, 677);
  assert(accepted.passed); assert(!rejected.passed); assert(rejected.first_bad_event);
  return { schema: 'rgb-gray-v4-pacing-negative-1', passed: true,
    positive: { model: identity(good.model), nodes: good.model.jk_bits,
      delay_nodes_per_gap: good.spec.scheduling.delay_nodes_per_gap, ...accepted },
    shortened_delay_counterexample: { model: identity(short.model), nodes: short.model.jk_bits,
      delay_nodes_per_gap: short.spec.scheduling.delay_nodes_per_gap,
      input_vector_lsb_first: f.bits, input: f.input, rgb: f.rgb, expected: f.expected, ...rejected },
    conditional_rewrites: checkConditionalRewrites(good),
    balanced_pipeline_comparison: balancedCost(good.core, good.spec.roles.selected_rgb),
    source_sha256: Object.fromEntries(['rgb-gray-v4-pacing-check.mjs', 'rgb-gray-v4.mjs', 'rgb-gray-v4-core.mjs'].map(p =>
      [p, sha256(fs.readFileSync(fileURLToPath(new URL(p, import.meta.url))))])),
    minimum_claim: 'D=24 works and D-1=23 has a concrete counterexample for this fixed graph and numbering. This is not a global model minimum proof.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = checkPacing(), target = process.argv[2] ?? '/private/tmp/rgb-gray-v4-pacing-negative.json';
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: target, passed: report.passed,
    positive_nodes: report.positive.nodes, shortened_nodes: report.shortened_delay_counterexample.nodes,
    first_bad_event: report.shortened_delay_counterexample.first_bad_event,
    conditional_frames: report.conditional_rewrites.frames }, null, 2));
}
