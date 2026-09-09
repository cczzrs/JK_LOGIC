import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModel, parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';

const ENGINE_FILE = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
const VERIFIER_FILE = fileURLToPath(import.meta.url);
const PIXELS = 9;
const SNAPSHOT_START = 433;
const ARITHMETIC_START = 649;
const RGB_CASES = 2 ** 24;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Repeated verification may replace its report, but never the model, including
// through a symlink or a different hard-link name.
function protectModel(modelFile, reportFile) {
  assert(resolve(modelFile) !== resolve(reportFile), 'Report path must differ from model path');
  if (existsSync(modelFile) && existsSync(reportFile)) {
    assert(realpathSync(modelFile) !== realpathSync(reportFile), 'Report resolves to the model file');
    const modelStat = statSync(modelFile), reportStat = statSync(reportFile);
    assert(modelStat.dev !== reportStat.dev || modelStat.ino !== reportStat.ino, 'Report is a hard link to the model file');
  }
}

function packArithmetic(first, evidence) {
  const starts = new Uint32Array(first.nodes.length + 1), operations = [], sources = [];
  first.nodes.forEach((tokens, node) => {
    starts[node] = operations.length;
    for (const token of tokens) {
      operations.push(token.op === 'J' ? 0 : 1);
      sources.push(token.source);
    }
  });
  starts[first.nodes.length] = operations.length;
  return {
    starts, operations: new Uint8Array(operations), sources: new Int32Array(sources), outputs: first.outputs,
    nodeCount: first.nodes.length, evidence,
  };
}

function inspectSharedArithmetic(raw, compiled) {
  const byId = new Map(compiled.nodes.map(node => [node.id, node]));
  const roles = raw.spec.roles;
  assert(roles && typeof roles === 'object', 'Shared model requires spec.roles');
  function roleArray(name, length) {
    const ids = roles[name];
    assert(Array.isArray(ids) && ids.length === length && new Set(ids).size === length,
      `Shared role ${name} must contain ${length} distinct node IDs`);
    for (const id of ids) assert(typeof id === 'string' && byId.has(id), `Shared role ${name} references missing node ${id}`);
    return ids;
  }
  function sameSources(node, expected, label) {
    assert(node.sources.length === expected.length && expected.every(id => node.sources.includes(id)),
      `${label} has unexpected source dependencies`);
  }
  const storage = roleArray('storage', 216);
  const selected = roleArray('selected_inputs', 24);
  const coreIds = roleArray('core', 168);
  const outputIds = roleArray('output_state', 72);
  const coreOutputs = roleArray('core_outputs', 8);
  const thresholds = roleArray('selector_thresholds', 8);
  const tick = byId.get(roles.tick);
  assert(tick && tick.initial === null, 'Shared tick must be an existing stateless node');
  assert(new Set([...storage, ...selected, ...coreIds, ...outputIds, ...thresholds, tick.id]).size ===
    storage.length + selected.length + coreIds.length + outputIds.length + thresholds.length + 1,
  'Shared arithmetic boundary roles overlap');
  for (const id of thresholds) assert(byId.get(id).initial === 1, `Shared selector ${id} must have initial q=1`);

  storage.forEach((id, index) => {
    const pixel = Math.floor(index / 24) + 1, channel = ['R', 'G', 'B'][Math.floor(index / 8) % 3];
    assert(id === `Q${index}` || id === `Q${index}L${pixel}${channel}${index % 8}`,
      `Storage role ${index} does not match the RGB input naming and bit order`);
    const node = byId.get(id);
    assert(node.initial === 0 && node.tokens.map(token => token.text).join('') === `J0K(X${index})`,
      `Storage ${id} must save exactly X${index} with initial q=0`);
  });

  function evaluate(node, values, initial = 0) {
    let value = initial;
    for (const token of node.tokens) {
      const input = token.source ? values.get(token.source) : token.constant;
      assert(input === 0 || input === 1, `Missing local truth-table input ${token.source}`);
      value = token.op === 'J' ? value & input : value ^ input;
    }
    return value;
  }
  function setThresholds(values, pixel) {
    // s1..s8 encode the selected zero-based pixel p as s_k = (p >= k).
    thresholds.forEach((id, index) => values.set(id, Number(pixel > index)));
  }
  let selectorCases = 0;
  selected.forEach((id, bit) => {
    const node = byId.get(id), pixelBits = Array.from({ length: PIXELS }, (_, pixel) => storage[pixel * 24 + bit]);
    assert(node.initial === null && node.required.length === 1 && node.required[0] === tick.id,
      `Selected input ${id} must be stateless and wait only for the shared tick`);
    sameSources(node, [...pixelBits, ...thresholds, tick.id], `Selected input ${id}`);
    const values = new Map();
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      setThresholds(values, pixel);
      for (let pattern = 0; pattern < 512; pattern++) {
        pixelBits.forEach((source, position) => values.set(source, (pattern >>> position) & 1));
        for (let tickValue = 0; tickValue < 2; tickValue++) {
          values.set(tick.id, tickValue);
          assert(evaluate(node, values) === ((pattern >>> pixel) & 1),
            `Selected input ${id} does not select RGB bit ${bit} of pixel ${pixel + 1}`);
          selectorCases++;
        }
      }
    }
  });

  const boundary = new Map(selected.map((id, index) => [id, index]));
  const allowedCore = new Set(coreIds), visiting = new Set(), indexes = new Map(), nodes = [], ids = [];
  function visit(id) {
    if (boundary.has(id)) return boundary.get(id);
    if (indexes.has(id)) return indexes.get(id);
    assert(allowedCore.has(id), `Shared core reads outside its 24 selected inputs and declared core: ${id}`);
    assert(!visiting.has(id), `Shared arithmetic cycle involving ${id}`);
    const node = byId.get(id);
    assert(node.initial === null && node.tokens[0].text === 'J0', `Shared core node ${id} must be stateless and begin with J0`);
    visiting.add(id);
    const normalized = node.tokens.map(token => ({
      op: token.op, source: token.source ? visit(token.source) : token.constant === 0 ? -1 : -2,
    }));
    visiting.delete(id);
    const index = 24 + nodes.length;
    indexes.set(id, index); nodes.push(normalized); ids.push(id);
    return index;
  }
  for (const id of coreOutputs) assert(allowedCore.has(id), `Shared core output ${id} is not an arithmetic node`);
  const outputs = coreOutputs.map(visit);
  assert(indexes.size === coreIds.length, 'Shared core role includes nodes outside the eight output ancestry graphs');
  const normalized = JSON.stringify({ nodes, outputs });

  let outputUpdateCases = 0;
  outputIds.forEach((id, index) => {
    const node = byId.get(id), pixel = Math.floor(index / 8), bit = index % 8, source = coreOutputs[bit];
    assert(compiled.outputs[index].source === id, `Y${index} must map to its corresponding shared output state ${id}`);
    assert(node.initial === 0 && node.required.length === 1 && node.required[0] === source,
      `Output state ${id} must have initial q=0 and wait only for shared core bit ${bit}`);
    const selectors = [...(pixel > 0 ? [thresholds[pixel - 1]] : []), ...(pixel < 8 ? [thresholds[pixel]] : [])];
    sameSources(node, [id, source, ...selectors], `Output state ${id}`);
    const values = new Map();
    for (let selectedPixel = 0; selectedPixel < PIXELS; selectedPixel++) {
      setThresholds(values, selectedPixel);
      for (const oldValue of [0, 1]) for (const newValue of [0, 1]) {
        values.set(id, oldValue); values.set(source, newValue);
        assert(evaluate(node, values, oldValue) === (pixel === selectedPixel ? newValue : oldValue),
          `Output state ${id} does not conditionally update pixel ${pixel + 1}, bit ${bit}`);
        outputUpdateCases++;
      }
    }
  });
  const done = byId.get(roles.core_done);
  assert(done && done.initial === 0, 'Shared core completion must have initial q=0');
  sameSources(done, coreOutputs, 'Shared core completion');
  assert(done.required.length === 8 && done.required.every(id => coreOutputs.includes(id)),
    'Shared core completion must wait for all eight arithmetic output sources');

  return packArithmetic({ nodes, outputs }, {
    architecture_mode: 'shared',
    arithmetic_core_instances: 1,
    arithmetic_nodes_per_core: nodes.length,
    total_arithmetic_nodes: nodes.length,
    canonical_core_sha256: sha256(normalized),
    normalization: 'Ordered eight-output ancestry traversal of the one shared core; preserve every JK token, constant, shared node and selected RGB input-bit reference',
    core_ids: ids,
    selected_input_boundary_lsb_first: selected,
    selected_input_mapping: '24 independent boundary bits in R0..R7, G0..G7, B0..B7 order; each actual selector is checked against all nine stored pixel positions',
    selector_local_truth_table_cases: selectorCases,
    selector_state_assumption: 'For zero-based selected pixel p, threshold s_k is 1 exactly when p >= k, k=1..8; generation and timing of these states require the FIFO verifier',
    output_condition_local_truth_table_cases: outputUpdateCases,
    core_output_sources_lsb_first: coreOutputs,
    conditional_output_sources: Array.from({ length: PIXELS }, (_, pixel) => ({ pixel: pixel + 1, sources_lsb_first: outputIds.slice(pixel * 8, pixel * 8 + 8) })),
    shared_core_invocations_per_frame: 'Nine invocations are a FIFO-verification obligation, not established by this arithmetic truth table',
  });
}

function inspectArithmetic(raw) {
  assert(raw.input_bits === 216 && raw.output_bits === 72, 'Expected 216 input bits and 72 output bits');
  assert(raw.spec?.operation === 'rgb-to-grayscale', 'Unexpected operation');
  assert(JSON.stringify(raw.spec.coefficients) === '[77,150,29]' && raw.spec.rounding_bias === 128 && raw.spec.divisor === 256,
    'The declared formula must use coefficients 77, 150, 29, bias 128 and divisor 256');
  const compiled = compileModel(raw);
  assert(compiled.issues.length === 0, `Model structural issues: ${compiled.issues.join('; ')}`);
  assert(compiled.nodes.every(node => node.errors.length === 0), 'Model contains invalid nodes or expressions');
  assert(compiled.outputs.length === 72 && compiled.outputs.every((output, index) => output.id === `Y${index}` && !output.error),
    'Expected exactly valid outputs Y0..Y71');
  assert(typeof raw.created_at === 'string' && raw.created_at.length > 0, 'Missing model created_at identity');
  assert(raw.spec.architecture_mode === undefined || raw.spec.architecture_mode === 'parallel' || raw.spec.architecture_mode === 'shared',
    'Unexpected grayscale architecture_mode');
  if (raw.spec.architecture_mode === 'shared') return inspectSharedArithmetic(raw, compiled);
  const byId = new Map(compiled.nodes.map(node => [node.id, node]));
  const snapshotSlots = new Map(Array.from({ length: 216 }, (_, index) => [`Q${SNAPSHOT_START + index}`, index]));
  for (const id of snapshotSlots.keys()) assert(byId.has(id) && byId.get(id).initial === null, `Missing or stateful snapshot ${id}`);

  const usedByPixel = new Map();
  const cores = [];
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const visiting = new Set(), indexes = new Map(), nodes = [], ids = [];
    // Postorder traversal from ordered Y bits gives the same canonical numbering
    // for every copy, without assuming contiguous or equal original node IDs.
    function visit(id) {
      if (snapshotSlots.has(id)) {
        const slot = snapshotSlots.get(id);
        assert(Math.floor(slot / 24) === pixel, `Pixel ${pixel + 1} reads another pixel's snapshot ${id}`);
        return slot % 24;
      }
      if (indexes.has(id)) return indexes.get(id);
      assert(!visiting.has(id), `Arithmetic cycle involving ${id}`);
      assert(/^Q(?:0|[1-9]\d*)$/.test(id) && Number(id.slice(1)) >= ARITHMETIC_START,
        `Arithmetic must depend only on its snapshots and arithmetic nodes, found ${id}`);
      const node = byId.get(id);
      assert(node && node.initial === null, `Missing or stateful arithmetic node ${id}`);
      assert(!usedByPixel.has(id) || usedByPixel.get(id) === pixel, `Arithmetic node ${id} is shared across pixels`);
      usedByPixel.set(id, pixel);
      visiting.add(id);
      const tokens = parseExpression(node.ex);
      assert(tokens[0].text === 'J0', `Arithmetic node ${id} must begin with J0`);
      const normalized = tokens.map(token => ({
        op: token.op,
        // Negative slots denote constant masks: -1 is zero and -2 is one.
        source: token.source ? visit(token.source) : token.constant === 0 ? -1 : -2,
      }));
      visiting.delete(id);
      const index = 24 + nodes.length;
      indexes.set(id, index);
      nodes.push(normalized);
      ids.push(id);
      return index;
    }
    const outputIds = compiled.outputs.slice(pixel * 8, pixel * 8 + 8).map(output => output.source);
    const outputs = outputIds.map(visit);
    const normalized = JSON.stringify({ nodes, outputs });
    cores.push({ nodes, outputs, ids, outputIds, normalized });
  }
  for (let pixel = 1; pixel < PIXELS; pixel++) {
    assert(cores[pixel].normalized === cores[0].normalized,
      `Pixel ${pixel + 1} arithmetic is not isomorphic to pixel 1 under local RGB and output-bit renaming`);
  }
  const actualArithmetic = compiled.nodes.filter(node => /^Q\d+$/.test(node.id) && Number(node.id.slice(1)) >= ARITHMETIC_START);
  assert(actualArithmetic.length === usedByPixel.size, 'Found arithmetic nodes outside the nine output ancestry graphs');
  assert(cores[0].nodes.length > 0, 'Empty arithmetic core');
  if (raw.spec.stages?.arithmetic_nodes_per_pixel !== undefined) {
    assert(raw.spec.stages.arithmetic_nodes_per_pixel === cores[0].nodes.length, 'Declared arithmetic node count does not match the actual graph');
  }
  const first = cores[0];
  return packArithmetic(first, {
      architecture_mode: 'parallel',
      pixels_checked: PIXELS,
      arithmetic_nodes_per_pixel: first.nodes.length,
      total_arithmetic_nodes: actualArithmetic.length,
      canonical_core_sha256: sha256(first.normalized),
      normalization: 'Ordered output-bit ancestry traversal; preserve every JK token, constant, shared node and local RGB snapshot-bit reference',
      disjoint_pixel_subgraphs: true,
      all_nine_subgraphs_isomorphic: true,
      snapshot_boundary: 'Q433..Q648, in per-pixel R0..R7, G0..G7, B0..B7 order; state and FIFO behavior are outside this checker',
      pixel_output_sources: cores.map((core, pixel) => ({ pixel: pixel + 1, sources_lsb_first: core.outputIds })),
    });
}

function exhaustiveArithmetic(core, evidence) {
  const values = new Int32Array(24 + core.nodeCount);
  const expectedMasks = new Int32Array(8);
  // Lane n corresponds to packed RGB value base+n. Since base is a multiple
  // of 32, its five low bits have these fixed masks and higher bits are uniform.
  values.set([0xaaaaaaaa, 0xcccccccc, 0xf0f0f0f0, 0xff00ff00, 0xffff0000]);
  const { starts, operations, sources, outputs } = core;
  for (let base = 0; base < RGB_CASES; base += 32) {
    for (let bit = 5; bit < 24; bit++) values[bit] = base & (1 << bit) ? -1 : 0;
    for (let node = 0; node < core.nodeCount; node++) {
      let value = 0;
      for (let token = starts[node]; token < starts[node + 1]; token++) {
        const source = sources[token];
        const input = source >= 0 ? values[source] : source === -1 ? 0 : -1;
        value = operations[token] === 0 ? value & input : value ^ input;
      }
      values[24 + node] = value;
    }
    expectedMasks.fill(0);
    const green = (base >>> 8) & 255, blue = base >>> 16;
    for (let lane = 0; lane < 32; lane++) {
      const red = (base + lane) & 255;
      // Independent integer oracle: no generator, column compressor, adder or
      // model-derived coefficient is used to obtain the expected byte.
      const expected = Math.floor((77 * red + 150 * green + 29 * blue + 128) / 256);
      const laneMask = 1 << lane;
      for (let bit = 0; bit < 8; bit++) if (expected & (1 << bit)) expectedMasks[bit] |= laneMask;
    }
    evidence.rgb_combinations_evaluated = base + 32;
    for (let bit = 0; bit < 8; bit++) {
      const difference = values[outputs[bit]] ^ expectedMasks[bit];
      if (difference !== 0) {
        const lane = 31 - Math.clz32(difference & -difference);
        let actual = 0;
        for (let outputBit = 0; outputBit < 8; outputBit++) actual |= ((values[outputs[outputBit]] >>> lane) & 1) << outputBit;
        const red = (base + lane) & 255;
        evidence.first_mismatch = {
          case_index: base + lane, R: red, G: green, B: blue,
          expected: Math.floor((77 * red + 150 * green + 29 * blue + 128) / 256), actual,
        };
        throw new Error(`Grayscale arithmetic mismatch: ${JSON.stringify(evidence.first_mismatch)}`);
      }
    }
    evidence.rgb_combinations_passed = base + 32;
    if ((base + 32) % (2 ** 21) === 0) console.error(`RGB truth table: ${base + 32}/${RGB_CASES} passed`);
  }
}

export function verifyGrayTruthTable(modelPath, reportPath) {
  const modelFile = resolve(modelPath), reportFile = resolve(reportPath);
  protectModel(modelFile, reportFile);
  const started = performance.now();
  const report = {
    status: 'failed',
    verification: 'Exhaustive single-pixel RGB arithmetic truth table with architecture-specific checks of the actual JSON graph',
    generated_at: new Date().toISOString(),
    model_identity: { path: modelFile, file_sha256: null, model_md5: null, created_at: null },
    verifier_identity: { path: VERIFIER_FILE, file_sha256: sha256(readFileSync(VERIFIER_FILE)), node_version: process.version },
    parser_engine_identity: { path: ENGINE_FILE, file_sha256: sha256(readFileSync(ENGINE_FILE)) },
    truth_table: {
      input_domain: 'Every (R,G,B) in {0,...,255}^3',
      input_enumeration: 'case_index = R + 256*G + 65536*B',
      expected_formula: 'Math.floor((77*R + 150*G + 29*B + 128) / 256)',
      total_rgb_combinations: RGB_CASES,
      rgb_combinations_evaluated: 0,
      rgb_combinations_passed: 0,
      bit_parallel_lanes: 32,
      evaluator: 'Parse actual JSON JK expressions, then execute each J as bitwise AND and K as bitwise XOR; constant one is all 32 bits set',
    },
    evidence_boundary: ['This is not enumeration of all 2^216 frame inputs, an all-trajectory state proof, a hardware result or a ModelShow browser test.'],
  };
  try {
    const bytes = readFileSync(modelFile);
    report.model_identity.file_sha256 = sha256(bytes);
    const raw = JSON.parse(bytes.toString('utf8'));
    report.model_identity.model_md5 = raw.md5 ?? null;
    report.model_identity.created_at = raw.created_at ?? null;
    const calculatedMd5 = createHash('md5').update(canonical({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec })).digest('hex');
    report.model_identity.recomputed_model_md5 = calculatedMd5;
    assert(raw.md5 === calculatedMd5, 'Model md5 does not match canonical nodes/initial_q/q_y/spec content');
    if (raw.spec?.architecture_mode === 'shared') {
      report.verification = 'Exhaustive numerical truth table of the one shared RGB arithmetic core, plus actual JSON selector and conditional-output boundary checks';
      report.evidence_boundary.unshift(
        'Exhaustive numerical verification of the one shared 24-input-bit arithmetic core. This does not claim nine distinct isomorphic arithmetic copies.',
        'Selected RGB inputs are independent Boolean boundary values. Local selector and output-update truth tables assume the stated valid threshold states; FIFO scheduling must separately establish those states and exactly nine complete core invocations per frame.',
        'Storage and output source structure is checked, but state trajectories, save-before-compute ordering, stopping, frame protocols, output event counts, reset and FIFO cache behavior require the independent shared-model verifier.',
      );
    } else {
      report.verification = 'Exhaustive single-pixel RGB arithmetic truth table, plus nine actual JSON subgraph isomorphism checks';
      report.evidence_boundary.unshift(
        'Exhaustive numerical verification of one 24-input-bit grayscale arithmetic graph, with verified isomorphic copies at all nine pixel positions.',
        'Snapshot inputs are treated as independent Boolean inputs. This does not verify storage, save-completion barrier, FIFO scheduling, frame protocols, output event counts, reset behavior or state trajectories.',
      );
    }
    const core = inspectArithmetic(raw);
    report.structure = core.evidence;
    exhaustiveArithmetic(core, report.truth_table);
    report.status = 'passed';
  } catch (error) {
    report.error = { name: error.name, message: error.message };
  }
  report.elapsed_seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  // Recheck immediately before writing so an existing alias cannot overwrite
  // the model even when verification itself failed.
  protectModel(modelFile, reportFile);
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 2, 'Usage: node scripts/verify-gray-truth-table.mjs MODEL REPORT');
    const report = verifyGrayTruthTable(args[0], args[1]);
    console.log(JSON.stringify({
      status: report.status, report: resolve(args[1]), model_md5: report.model_identity.model_md5,
      created_at: report.model_identity.created_at,
      rgb_combinations_passed: report.truth_table.rgb_combinations_passed,
      isomorphic_pixel_graphs: report.structure?.pixels_checked ?? 0,
      ...(report.structure?.architecture_mode === 'shared' ? { shared_core_instances: report.structure.arithmetic_core_instances } : {}),
      elapsed_seconds: report.elapsed_seconds,
      ...(report.error ? { error: report.error.message } : {}),
    }));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
