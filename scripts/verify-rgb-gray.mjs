import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as defaultEngine from '../skills/jk-network-generator/scripts/engine.mjs';
import { digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';

const INPUT_BITS = 216, OUTPUT_BITS = 72, SNAPSHOT_START = 433, COMPUTE_START = 649;
const SEED = 0x62d917a3;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const portIds = (prefix, count) => Array.from({ length: count }, (_, i) => prefix + i);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const BOUNDARY = 'Sampled 216-bit input domain, using the actual FIFO interpreter. Each input bit is sent exactly once per frame; frames never overlap and each completed frame drains the queue and all arrival caches. Partial frames may pause indefinitely. Tests do not establish correctness for repeated input keys within a frame, overlapping frames, arbitrary initial q, all 2^216 input vectors, external hardware, browser integration, or global minimum node count. Outputs publish separately after the full input has been stored, not atomically as a 72-bit bus.';

function storageId(index, profile) {
  if (profile === 'numeric-compatibility') return 'Q' + index;
  const pixel = Math.floor(index / 24) + 1;
  const channel = 'RGB'[Math.floor(index / 8) % 3];
  return `Q${index}L${pixel}${channel}${index % 8}`;
}

/** Structural validation is independent of explanatory metadata. */
export function validate(raw, { engineModule = defaultEngine } = {}) {
  assert(object(raw), 'Model must be a JSON object');
  assert(raw.format === 'jk-logic-structure-V3.1.0', 'Unexpected model format');
  assert(typeof raw.name === 'string' && raw.name.length > 0, 'Missing model name');
  assert(typeof raw.created_at === 'string' && Number.isFinite(Date.parse(raw.created_at)) && new Date(raw.created_at).toISOString() === raw.created_at, 'created_at must be an ISO UTC timestamp');
  assert(raw.input_bits === INPUT_BITS && raw.output_bits === OUTPUT_BITS, 'Expected 216 input bits and 72 output bits');
  const spec = raw.spec;
  assert(object(spec) && spec.signed === false && spec.bit_order === 'LSB-first', 'Expected unsigned LSB-first spec');
  assert(['pixel-suffixed', 'numeric-compatibility'].includes(spec.id_profile), 'Unknown storage ID profile');
  for (const [key, width] of [['input_bits', INPUT_BITS], ['output_bits', OUTPUT_BITS]]) {
    assert(!Object.hasOwn(spec, key) || spec[key] === width, `spec.${key} is inconsistent`);
  }
  assert(Array.isArray(raw.nodes) && raw.nodes.length > COMPUTE_START, 'Missing computation nodes');
  for (const node of raw.nodes) {
    assert(object(node) && typeof node.id === 'string' && typeof node.ex === 'string', 'Each node must have string id and ex');
  }
  const model = engineModule.compileModel(raw);
  assert(model.issues.length === 0, 'Compiler issues: ' + model.issues.join('; '));
  const errors = model.nodes.filter(node => node.errors.length);
  assert(errors.length === 0, 'Invalid nodes: ' + errors.slice(0, 10).map(node => `${node.id}: ${node.errors.join(', ')}`).join('; '));
  assert(model.outputs.every(output => !output.error), 'Invalid output mapping');
  assert(equal(model.inputs, portIds('X', INPUT_BITS)), 'Actual input references must cover X0..X215 exactly');
  assert(equal(model.outputs.map(output => output.id), portIds('Y', OUTPUT_BITS)), 'Actual outputs must cover Y0..Y71 exactly');
  assert(equal(raw.inputs, portIds('X', INPUT_BITS).map(id => ({ [id]: id }))), 'Input metadata mapping mismatch');
  assert(equal(raw.outputs, portIds('Y', OUTPUT_BITS).map(id => ({ [id]: id }))), 'Output metadata mapping mismatch');
  const stateIds = Array.from({ length: INPUT_BITS }, (_, i) => storageId(i, spec.id_profile));
  assert(equal(raw.initial_q, { '0': stateIds, '1': [] }), 'Exactly the 216 input storage nodes must initialize to q=0');
  const byId = new Map(model.nodes.map(node => [node.id, node]));
  const indexById = new Map(model.nodes.map((node, index) => [node.id, index]));
  for (let i = 0; i < model.nodes.length; i++) {
    const node = model.nodes[i];
    assert(node.id === (i < INPUT_BITS ? stateIds[i] : 'Q' + i), `Node ordering or ID mismatch at index ${i}`);
    assert(node.sources.length > 0, `Pure constant node ${node.id} would not republish each frame`);
    assert(node.initial === (i < INPUT_BITS ? 0 : null), `Incorrect state classification for ${node.id}`);
    for (const source of node.sources) {
      if (source.startsWith('Q')) assert(indexById.get(source) < i, `Dependency must precede ${node.id}: ${source}`);
    }
    if (i < INPUT_BITS) {
      assert(node.ex.replace(/\s/g, '') === `J0K(X${i})`, `Storage ${node.id} must save its own input bit`);
      assert(equal(node.required, ['X' + i]), `Storage ${node.id} has incorrect arrival requirements`);
    } else if (i < 432) {
      const source = stateIds[i - INPUT_BITS];
      assert(node.ex.replace(/\s/g, '') === `J0K(${source})J0K1`, `Receipt ${node.id} must publish 1 after its storage event`);
      assert(node.required.length === 0, `Receipt ${node.id} should read live state without an arrival slot`);
    } else if (i === 432) {
      const sources = portIds('Q', 432).slice(INPUT_BITS);
      assert(node.ex.replace(/\s/g, '') === 'J0' + sources.map(id => `K(${id})`).join('') + 'J0K1', 'Full-frame barrier must require every one of the 216 receipt events');
      assert(equal(node.required, sources), 'Barrier arrival slots must cover every receipt');
    } else if (i < COMPUTE_START) {
      const source = stateIds[i - SNAPSHOT_START];
      assert(node.ex.replace(/\s/g, '') === `J0K(Q432)J0K(${source})`, `Snapshot ${node.id} must wait for the barrier then read saved input`);
      assert(equal(node.required, ['Q432']), `Snapshot ${node.id} has incorrect arrival requirements`);
    } else {
      assert(node.sources.every(source => source.startsWith('Q') && indexById.get(source) >= SNAPSHOT_START), `Computation ${node.id} must use snapshots or preceding computation only`);
      assert(equal(node.required, node.sources), `Computation ${node.id} must wait for all its stateless sources`);
    }
  }
  assert(model.outputs.every(output => indexById.get(output.source) >= COMPUTE_START), 'Outputs must be sourced from the gray computation');
  // Check every node contributes to an output, including all receipt paths.
  const live = new Set();
  const pending = model.outputs.map(output => output.source);
  while (pending.length) {
    const id = pending.pop();
    if (live.has(id)) continue;
    live.add(id);
    pending.push(...byId.get(id).sources.filter(source => source.startsWith('Q')));
  }
  assert(live.size === model.nodes.length, 'Model contains nodes disconnected from all output dependencies');
  for (const [key, value] of Object.entries(metrics(raw.nodes))) assert(raw[key] === value, `Incorrect model statistic ${key}`);
  assert(typeof raw.md5 === 'string' && raw.md5 === digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec }), 'Model structural MD5 mismatch');
  return { model, stateIds, indexById };
}

/** Independent byte-level oracle: no Builder or JK-expression evaluation. */
export function expectedGray(bytes) {
  assert(bytes.length === 27 && Array.from(bytes).every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'Expected 27 unsigned RGB bytes');
  return Array.from({ length: 9 }, (_, pixel) => {
    const start = pixel * 3;
    return Math.floor((77 * bytes[start] + 150 * bytes[start + 1] + 29 * bytes[start + 2] + 128) / 256);
  });
}

function frameBits(bytes) {
  return Uint8Array.from({ length: INPUT_BITS }, (_, i) => (bytes[Math.floor(i / 8)] >>> (i % 8)) & 1);
}

function uniform(r, g = r, b = r) {
  return Uint8Array.from({ length: 27 }, (_, i) => [r, g, b][i % 3]);
}

export function verify(raw, { samples = 10000, reload = () => JSON.parse(JSON.stringify(raw)), progress = null, engineModule = defaultEngine } = {}) {
  const coverage = {
    boundary_frames: 0, gray_identity_frames: 0, one_hot_frames: 0,
    one_cold_frames: 0, fixed_seed_random_frames: 0, repeated_value_frames: 0,
    missing_one_bit_frames: 0, shuffled_one_bit_frames: 0,
    interleaved_step_frames: 0, reset_frames: 0, reload_frames: 0,
    partial_reset_checks: 0,
  };
  let phase = 'structure', currentFrame = null, engine = null;
  let executions = 0, peakQueue = 0, completed = 0;
  const uniqueFrames = new Set();
  const started = performance.now();
  try {
    assert(Number.isInteger(samples) && samples >= 1 && samples <= 1000000, 'samples must be an integer in 1..1000000');
    let checked = validate(raw, { engineModule });
    const nodeCount = checked.model.nodes.length;
    const options = { historyLimit: 0, queueLimit: Math.max(10000, nodeCount * 2) };
    engine = new engineModule.JKEngine(checked.model, options);
    const assertInitial = () => {
      assert(engine.total === 0 && engine.length === 0, 'Initial/reset engine must have no executions or queued work');
      assert(engine.q.size === INPUT_BITS && checked.stateIds.every(id => engine.q.get(id) === 0), 'Initial/reset q must contain exactly 216 zeros');
      assert([...engine.outputs.values()].every(value => value === null), 'Initial/reset outputs must be unpublished');
      assert([...engine.cache.values()].every(cache => cache.size === 0), 'Initial/reset arrival caches must be empty');
      assert(engine.latest.size === 0 && engine.last.size === 0 && [...engine.counts.values()].every(count => count === 0), 'Reset must clear publication and execution bookkeeping');
    };
    assertInitial();

    function checkFrame(bytes, category, schedule = null) {
      phase = category;
      assert(engine.length === 0 && [...engine.cache.values()].every(cache => cache.size === 0), 'Previous frame did not drain');
      const bits = frameBits(bytes), expected = expectedGray(bytes);
      const sent = new Uint8Array(INPUT_BITS), counts = new Uint8Array(nodeCount), publications = new Uint8Array(OUTPUT_BITS);
      let savedCount = 0, barrierCount = 0, frameExecutions = 0;
      const outputsBefore = [...engine.outputs.values()];
      const stateBefore = checked.stateIds.map(id => engine.q.get(id));
      currentFrame = { category, rgb_bytes: Array.from(bytes), expected_gray: expected, actual_gray: null, executed: 0 };

      function send(indices) {
        const input = {};
        for (const i of indices) {
          assert(Number.isInteger(i) && i >= 0 && i < INPUT_BITS && sent[i] === 0, 'Test schedule must send each Xi exactly once');
          sent[i] = 1;
          input['X' + i] = bits[i];
        }
        const event = engine.send(input);
        assert(event.accepted.length === indices.length && event.ignored.length === 0, 'Engine did not accept precisely the requested input bits');
      }

      function step() {
        assert(frameExecutions < nodeCount, 'Frame repeated execution or exceeded its DAG budget');
        peakQueue = Math.max(peakQueue, engine.length);
        const event = engine.step();
        assert(event?.type === 'execution', 'Expected a real FIFO execution');
        executions++; frameExecutions++; currentFrame.executed = frameExecutions;
        const index = checked.indexById.get(event.node);
        assert(index !== undefined && counts[index]++ === 0, `${event.node} executed more than once in one frame`);
        if (index < INPUT_BITS) {
          assert(event.before === stateBefore[index], `${event.node} did not retain the preceding frame's saved bit`);
          assert(sent[index] === 1 && event.value === bits[index] && engine.q.get(event.node) === bits[index], `${event.node} failed to save its input bit`);
          savedCount++;
        } else if (index < 432) {
          assert(counts[index - INPUT_BITS] === 1 && event.value === 1, 'Receipt executed before storage or emitted the wrong value');
        } else if (index === 432) {
          assert(savedCount === INPUT_BITS && sent.every(value => value === 1), 'Barrier fired before all 216 inputs were stored');
          assert(counts.slice(INPUT_BITS, 432).every(value => value === 1), 'Barrier fired before all 216 receipt executions');
          assert(event.value === 1 && checked.stateIds.every((id, i) => engine.q.get(id) === bits[i]), 'Barrier did not follow a complete valid saved frame');
          barrierCount++;
        } else {
          assert(savedCount === INPUT_BITS && barrierCount === 1, 'Snapshot or gray computation executed before every input was stored');
          if (index < COMPUTE_START) assert(event.value === bits[index - SNAPSHOT_START], 'Snapshot did not capture the saved input bit');
        }
        for (const transfer of event.transfers) if (transfer.target.startsWith('Y')) {
          const output = Number(transfer.target.slice(1));
          assert(output >= 0 && output < OUTPUT_BITS && barrierCount === 1 && savedCount === INPUT_BITS, 'Unexpected or premature output event');
          assert(publications[output]++ === 0, `${transfer.target} published more than once in the frame`);
          assert(transfer.value === ((expected[Math.floor(output / 8)] >>> (output % 8)) & 1), `${transfer.target} disagrees with independent integer oracle`);
        }
      }

      function drain() { while (engine.length) step(); }

      function assertIncomplete() {
        assert(sent.some(value => value === 0), 'Incomplete-frame check requires a missing input');
        assert(barrierCount === 0 && counts.slice(432).every(value => value === 0), 'Incomplete frame performed a barrier, snapshot or computation');
        assert(publications.every(value => value === 0) && equal([...engine.outputs.values()], outputsBefore), 'Incomplete frame altered/published outputs');
        assert(checked.stateIds.every((id, i) => engine.q.get(id) === (counts[i] ? bits[i] : stateBefore[i])), 'Partial input altered an unwritten state bit');
        if (!engine.length) {
          const cache = engine.cache.get(checked.model.nodes[432].key);
          assert(cache.size === savedCount, 'Partial barrier did not retain exactly the completed receipt arrivals');
          assert(engine.step() === null, 'An idle partial frame unexpectedly resumed');
        }
      }

      if (schedule) schedule({ send, step, drain, assertIncomplete, engine });
      else send(Array.from({ length: INPUT_BITS }, (_, i) => i));
      drain();
      assert(sent.every(value => value === 1) && counts.every(value => value === 1), 'Every input and every reachable node must execute once per completed frame');
      assert(barrierCount === 1 && publications.every(value => value === 1), 'Each output must freshly publish exactly once per completed frame');
      const actual = Array.from({ length: 9 }, (_, pixel) => {
        let value = 0;
        for (let bit = 0; bit < 8; bit++) {
          const output = engine.outputs.get('Y' + (pixel * 8 + bit));
          assert(output === 0 || output === 1, 'Output bit was never published');
          value += output * (2 ** bit);
        }
        return value;
      });
      currentFrame.actual_gray = actual;
      assert(equal(actual, expected), 'Output grayscale bytes disagree with independent oracle');
      assert(engine.q.size === INPUT_BITS && checked.stateIds.every((id, i) => engine.q.get(id) === bits[i]), 'Completed frame did not preserve all 216 RGB bits');
      assert(engine.length === 0 && [...engine.cache.values()].every(cache => cache.size === 0), 'Completed frame left queued work or arrival cache entries');
      const retained = [...engine.q.values()];
      assert(engine.step() === null && equal([...engine.q.values()], retained), 'Idle step changed saved inputs');
      coverage[category]++;
      completed++;
      uniqueFrames.add(Buffer.from(bytes).toString('hex'));
      currentFrame = null;
      if (progress && completed % 500 === 0) progress({ completed_frames: completed, executions, elapsed_seconds: (performance.now() - started) / 1000 });
    }

    const boundaries = [
      uniform(0), uniform(255), uniform(255, 0, 0), uniform(0, 255, 0), uniform(0, 0, 255),
      uniform(255, 255, 0), uniform(255, 0, 255), uniform(0, 255, 255),
      uniform(1, 0, 0), uniform(0, 1, 0), uniform(0, 0, 1),
      uniform(254, 255, 255), uniform(255, 254, 255), uniform(255, 255, 254),
      uniform(127, 128, 129), uniform(128, 127, 126),
      Uint8Array.from({ length: 27 }, (_, i) => (i * 73 + 19) & 255),
      Uint8Array.from({ length: 27 }, (_, i) => i % 2 ? 0x55 : 0xaa),
    ];
    for (const bytes of boundaries) checkFrame(bytes, 'boundary_frames');
    for (let value = 0; value < 256; value++) checkFrame(uniform(value), 'gray_identity_frames');
    for (let bit = 0; bit < INPUT_BITS; bit++) {
      const hot = new Uint8Array(27), cold = new Uint8Array(27).fill(255);
      hot[Math.floor(bit / 8)] = 1 << (bit % 8);
      cold[Math.floor(bit / 8)] ^= 1 << (bit % 8);
      checkFrame(hot, 'one_hot_frames'); checkFrame(cold, 'one_cold_frames');
    }
    let seed = SEED;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let sample = 0; sample < samples; sample++) {
      checkFrame(Uint8Array.from({ length: 27 }, () => random() & 255), 'fixed_seed_random_frames');
    }
    // Same interpreter, no reset across boundaries, samples and repeat tests.
    for (const bytes of [uniform(255), uniform(255), uniform(0), uniform(0), boundaries[16], boundaries[16]]) checkFrame(bytes, 'repeated_value_frames');
    for (let missing = 0; missing < INPUT_BITS; missing++) {
      const bytes = Uint8Array.from({ length: 27 }, (_, i) => (missing * 43 + i * 91) & 255);
      checkFrame(bytes, 'missing_one_bit_frames', ({ send, drain, assertIncomplete }) => {
        send(Array.from({ length: INPUT_BITS }, (_, i) => i).filter(i => i !== missing));
        drain(); assertIncomplete(); send([missing]);
      });
    }
    for (const order of [
      Array.from({ length: INPUT_BITS }, (_, i) => INPUT_BITS - 1 - i),
      Array.from({ length: INPUT_BITS }, (_, i) => (i * 73) % INPUT_BITS),
    ]) {
      checkFrame(boundaries[16], 'shuffled_one_bit_frames', ({ send, drain, assertIncomplete }) => {
        for (let i = 0; i < order.length; i++) {
          send([order[i]]); drain();
          if (i + 1 < order.length) assertIncomplete();
        }
      });
    }
    checkFrame(boundaries[17], 'interleaved_step_frames', ({ send, step, assertIncomplete, engine: active }) => {
      for (let start = 0; start < INPUT_BITS; start += 7) {
        send(Array.from({ length: Math.min(7, INPUT_BITS - start) }, (_, offset) => start + offset));
        if (active.length) step();
        if (start + 7 < INPUT_BITS) assertIncomplete();
      }
    });
    phase = 'reset';
    engine.reset(); assertInitial();
    for (const bytes of [uniform(0), uniform(255), boundaries[16]]) checkFrame(bytes, 'reset_frames');
    // Reset a partially received frame as well as a completed frame.
    const partialBits = frameBits(uniform(255));
    engine.send(Object.fromEntries(Array.from({ length: 107 }, (_, i) => ['X' + i, partialBits[i]])));
    while (engine.length) { peakQueue = Math.max(peakQueue, engine.length); engine.step(); executions++; }
    assert(engine.cache.get(checked.model.nodes[432].key).size === 107, 'Partial reset setup did not preserve arrivals');
    engine.reset(); assertInitial(); coverage.partial_reset_checks++;
    checkFrame(uniform(0), 'reset_frames');
    phase = 'reload';
    const reloaded = reload();
    assert(reloaded.md5 === raw.md5 && reloaded.created_at === raw.created_at && digest(reloaded) === digest(raw), 'Reloaded file changed during verification');
    checked = validate(reloaded, { engineModule });
    engine = new engineModule.JKEngine(checked.model, options); assertInitial();
    for (const bytes of [uniform(0), uniform(255), boundaries[16]]) checkFrame(bytes, 'reload_frames');
    return {
      passed: true, verification: 'rgb-gray-storage-fifo-v1', mode: 'sampled',
      input_domain_combinations: (1n << 216n).toString(), random_seed: '0x' + SEED.toString(16), requested_random_samples: samples,
      model_md5: raw.md5, model_created_at: raw.created_at, id_profile: raw.spec.id_profile,
      input_bits: INPUT_BITS, output_bits: OUTPUT_BITS, nodes: nodeCount, persistent_state_bits: INPUT_BITS,
      completed_frames: completed, unique_complete_input_vectors: uniqueFrames.size, coverage,
      executions, peak_queue: peakQueue, elapsed_seconds: (performance.now() - started) / 1000,
      oracle: 'For each row-major RGB pixel: floor((77*R + 150*G + 29*B + 128)/256); bytes are unsigned; each byte is LSB-first.',
      checks: [
        'Recompiled parsed model; strict storage names, initial q, ports, metrics, MD5 and forward-only dependency graph checked.',
        'All 216 state nodes -> all 216 stateless receipts -> one full-frame barrier -> 216 snapshots; computation consumes snapshots only.',
        'Actual JKEngine.send/step; every reachable node and every output publishes exactly once per completed frame.',
        'All 216 storage updates precede any snapshot, gray computation or output; saved state persists between sends and while idle.',
        'Each of 216 possible single missing inputs tested separately: queue drains without computation, retained receipts resume after final bit.',
        'Single-bit reverse/shuffled sending and input batches interleaved with unfinished FIFO execution verified.',
        'Continuous frames including repeated values and white-to-black transition; no reset between main test cases.',
        'All 256 equal-RGB byte values, 216 one-hot and 216 one-cold vectors, color boundaries and fixed-seed random frames.',
        'Independent reset from completed/partial frames and reread/recompiled model initialization; queues/caches drain after complete frames.',
      ],
      boundary: BOUNDARY,
    };
  } catch (error) {
    error.report = {
      passed: false, verification: 'rgb-gray-storage-fifo-v1', mode: 'sampled', phase, error: error.message,
      model_md5: raw?.md5 ?? null, model_created_at: raw?.created_at ?? null,
      requested_random_samples: samples, completed_frames: completed, coverage,
      counterexample: currentFrame, executions, peak_queue: peakQueue,
      elapsed_seconds: (performance.now() - started) / 1000, boundary: BOUNDARY,
    };
    throw error;
  }
}

export function assertSeparateFiles(modelPath, reportPath) {
  const modelAbsolute = resolve(modelPath), reportAbsolute = resolve(reportPath);
  assert(modelAbsolute !== reportAbsolute, 'Report path must not overwrite model');
  if (existsSync(modelAbsolute) && existsSync(reportAbsolute)) {
    const a = statSync(modelAbsolute), b = statSync(reportAbsolute);
    assert(a.dev !== b.dev || a.ino !== b.ino, 'Report path aliases model through symlink or hard link');
  }
  const canonicalPath = path => existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), basename(path));
  assert(canonicalPath(modelAbsolute) !== canonicalPath(reportAbsolute), 'Resolved report path must not overwrite model');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [modelPath, reportPath, ...flags] = process.argv.slice(2);
  let writable = false, phase = 'arguments', identity = {};
  try {
    assert(modelPath && reportPath, 'Usage: node verify-rgb-gray.mjs MODEL.json REPORT.json [--samples 10000] [--engine engine.mjs]');
    phase = 'report-path'; assertSeparateFiles(modelPath, reportPath); writable = true;
    phase = 'arguments';
    let samples = 10000, enginePath = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
    const supplied = new Set();
    for (let i = 0; i < flags.length; i += 2) {
      const flag = flags[i], value = flags[i + 1];
      assert(['--samples', '--engine'].includes(flag) && value !== undefined && !supplied.has(flag), 'Expected unique --samples N and/or --engine engine.mjs options');
      supplied.add(flag);
      if (flag === '--samples') samples = Number(value); else enginePath = resolve(value);
    }
    const engineModule = await import(pathToFileURL(enginePath).href);
    assert(typeof engineModule.compileModel === 'function' && typeof engineModule.JKEngine === 'function', 'Selected module must export compileModel and JKEngine');
    phase = 'read-model';
    const bytes = readFileSync(modelPath), raw = JSON.parse(bytes.toString('utf8'));
    identity = {
      model_path: realpathSync(modelPath), model_file_sha256: sha256(bytes),
      engine_path: realpathSync(enginePath), engine_sha256: sha256(readFileSync(enginePath)),
      verifier_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    };
    const result = verify(raw, {
      samples, engineModule,
      reload: () => {
        const reloaded = readFileSync(modelPath);
        assert(sha256(reloaded) === identity.model_file_sha256, 'Model file changed during verification');
        return JSON.parse(reloaded.toString('utf8'));
      },
      progress: data => process.stderr.write(JSON.stringify({ progress: data }) + '\n'),
    });
    phase = 'write-report'; assertSeparateFiles(modelPath, reportPath);
    const report = { ...result, ...identity, verified_at: new Date().toISOString() };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ passed: true, report: resolve(reportPath), completed_frames: report.completed_frames, nodes: report.nodes, executions: report.executions, elapsed_seconds: report.elapsed_seconds }) + '\n');
  } catch (error) {
    const failure = { ...(error.report ?? { passed: false, phase, error: error.message, mode: 'sampled', boundary: BOUNDARY }), ...identity, verified_at: new Date().toISOString() };
    if (writable && phase !== 'write-report') {
      try { assertSeparateFiles(modelPath, reportPath); writeFileSync(reportPath, JSON.stringify(failure, null, 2) + '\n'); }
      catch (writeError) { process.stderr.write(`Cannot write failure report: ${writeError.message}\n`); }
    }
    process.stderr.write(JSON.stringify(failure) + '\n'); process.exitCode = 1;
  }
}
