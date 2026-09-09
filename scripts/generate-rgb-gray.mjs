import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Builder, digest, metrics } from '../skills/jk-network-generator/scripts/generate.mjs';
import { parseExpression } from '../skills/jk-network-generator/scripts/engine.mjs';
import { generateRgbGrayShared, generateUnoptimizedRgbGrayShared } from './rgb-gray-shared.mjs';
import { auditModels } from './audit-rgb-gray-ex.mjs';

const CHANNELS = ['R', 'G', 'B'];
const COEFFICIENTS = [77, 150, 29];
const INPUT_BITS = 216;
const OUTPUT_BITS = 72;
const BARRIER = 'Q432';
const SNAPSHOT_START = 433;
const CORE_START = 649;
const hashContract = 'md5 = lowercase MD5 of UTF-8 recursively key-sorted JSON of {nodes, initial_q, q_y, spec}; array order retained';

export function storageId(i, profile = 'pixel-suffixed') {
  const pixel = Math.floor(i / 24) + 1;
  const channel = CHANNELS[Math.floor(i / 8) % 3];
  return profile === 'numeric-compatibility' ? `Q${i}` : `Q${i}L${pixel}${channel}${i % 8}`;
}

// One pixel: constant coefficients are wiring shifts, not general multipliers.
// Every intermediate mathematical sum is at most 256*255+128 = 65,408.
// Compress each bit-weight column, add the remaining two rows, retain bits 8..15.
export function pixelCore(optimize = true) {
  const builder = new Builder(optimize);
  const columns = Array.from({ length: 17 }, () => []);
  for (let c = 0; c < 3; c++) {
    for (let shift = 0; shift < 8; shift++) if ((COEFFICIENTS[c] >> shift) & 1) {
      for (let b = 0; b < 8; b++) columns[b + shift].push(`X${c * 8 + b}`);
    }
  }
  columns[7].push(1); // +128 gives round-half-up before division by 256.
  for (let weight = 0; weight < 16; weight++) {
    while (columns[weight].length > 2) {
      const [sum, carry] = builder.fullAdder(...columns[weight].splice(0, 3));
      columns[weight].push(sum);
      columns[weight + 1].push(carry);
    }
  }
  const sum = builder.add(
    columns.slice(0, 16).map(c => c[0] ?? 0),
    columns.slice(0, 16).map(c => c[1] ?? 0),
    16,
  );
  const outputs = sum.slice(8, 16);
  const byId = new Map(builder.nodes.map(n => [n.id, n]));
  const live = new Set();
  function visit(id) {
    if (typeof id !== 'string' || !id.startsWith('Q') || live.has(id)) return;
    live.add(id);
    for (const t of parseExpression(byId.get(id).ex)) if (t.source) visit(t.source);
  }
  outputs.forEach(visit);
  return {
    nodes: builder.nodes.filter(n => live.has(n.id)), outputs,
    emitted_nodes: builder.nodes.length,
  };
}

export function generateRgbGray({ profile = 'pixel-suffixed', createdAt = new Date().toISOString() } = {}) {
  if (!['pixel-suffixed', 'numeric-compatibility'].includes(profile)) throw new Error('Unknown ID profile');
  const states = Array.from({ length: INPUT_BITS }, (_, i) => storageId(i, profile));
  const completions = states.map((_, i) => `Q${216 + i}`);
  const snapshots = states.map((_, i) => `Q${SNAPSHOT_START + i}`);
  const nodes = states.map((id, i) => ({ id, ex: `J0K(X${i})` }));
  // A state q is not an arrival slot. These stateless publications provide
  // one completion token per saved bit, including writes of unchanged values.
  nodes.push(...states.map((id, i) => ({ id: completions[i], ex: `J0K(${id})J0K1` })));
  nodes.push({ id: BARRIER, ex: 'J0' + completions.map(id => `K(${id})`).join('') + 'J0K1' });
  nodes.push(...states.map((id, i) => ({ id: snapshots[i], ex: `J0K(${BARRIER})J0K(${id})` })));

  const core = pixelCore(true);
  const baseline = pixelCore(false);
  const outputSources = [];
  for (let pixel = 0; pixel < 9; pixel++) {
    const remap = new Map(core.nodes.map((n, i) => [n.id, `Q${nodes.length + i}`]));
    const mapSource = source => source.startsWith('X')
      ? snapshots[pixel * 24 + Number(source.slice(1))]
      : remap.get(source);
    for (const n of core.nodes) {
      const ex = parseExpression(n.ex).map(t => t.source ? `${t.op}(${mapSource(t.source)})` : `${t.op}${t.constant}`).join('');
      nodes.push({ id: remap.get(n.id), ex });
    }
    outputSources.push(...core.outputs.map(mapSource));
  }
  const spec = {
    operation: 'rgb-to-grayscale',
    architecture: '216 persistent input bits, stateless save-completion barrier and snapshots, nine stateless fixed-coefficient grayscale cores',
    id_profile: profile,
    required_extensions: profile === 'pixel-suffixed' ? ['pixel-node-id-v1'] : [],
    input_bits: INPUT_BITS, output_bits: OUTPUT_BITS,
    signed: false, bit_order: 'LSB-first',
    width: 3, height: 3, pixel_order: 'row-major, L1 is top-left, L9 is bottom-right',
    channels: CHANNELS,
    input_mapping: 'X[24*p + 8*c + b]: p=0..8, c=0:R/1:G/2:B, b=0..7 (LSB=0)',
    output_mapping: 'Y[8*p + b]: p=0..8, b=0..7 (LSB=0)',
    output_encoding: 'nine unsigned 8-bit grayscale pixels in row-major order',
    formula: 'floor((77*R + 150*G + 29*B + 128) / 256)',
    coefficients: COEFFICIENTS, rounding_bias: 128, divisor: 256,
    intermediate_bits: 16, maximum_numerator: 65408,
    rounding: 'nearest integer; exact half rounds up',
    color_processing: 'integer approximation on supplied encoded RGB bytes; no gamma decoding or color-space conversion',
    input_protocol: 'Each frame supplies every X0..X215 exactly once, in one send or disjoint partial sends. Execution may occur between sends. Send no bit of the next frame until all 72 current output bits have published and FIFO is drained. No overlapping frames or repeated Xi within an incomplete frame.',
    incomplete_frame: 'save received bits, retain unsent state bits, publish no new grayscale output until all 216 save completions arrive; reset may discard an incomplete frame',
    output_validity: 'Each Yi publishes exactly once per complete frame, after all 216 state writes. Outputs publish separately; the complete 72-bit result is valid after all 72 fresh publications and FIFO drain. During a partial next frame, outputs retain the previous frame values.',
    state_initialization: 'all 216 input-state q bits are 0; initialization emits no output',
    state_update: 'J0K(Xi) overwrites the corresponding saved q with the new input bit; q persists until its next input event or reset',
    storage_naming: 'Q{i}L{p+1}{channel}{b}; i=24*p+8*c+b, channel=R/G/B, b=0..7',
    stages: {
      storage: states,
      completion: completions,
      all_saved: BARRIER,
      snapshot: snapshots,
      arithmetic_start: `Q${CORE_START}`,
      arithmetic_nodes_per_pixel: core.nodes.length,
    },
    optimization: {
      method: 'constant coefficients by shifted wiring, bit-column full-adder compression, shared Boolean expressions and constants, prune arithmetic nodes outside output ancestry',
      optimized_arithmetic_nodes_per_pixel: core.nodes.length,
      no_optional_simplification_arithmetic_nodes_per_pixel: baseline.nodes.length,
      retained_storage_bits: INPUT_BITS,
      barrier_dependencies_preserved: true,
      global_minimum_claimed: false,
    },
  };
  if (profile === 'numeric-compatibility') {
    spec.storage_name_aliases = Object.fromEntries(states.map((id, i) => [id, storageId(i)]));
  }
  const raw = {
    name: `3x3 RGB 216-bit saved-input to 72-bit grayscale (${profile})`,
    format: 'jk-logic-structure-V3.1.0', created_at: createdAt,
    input_bits: INPUT_BITS, output_bits: OUTPUT_BITS, ...metrics(nodes),
    nodes, initial_q: { '0': states, '1': [] },
    q_y: outputSources.map((id, i) => ({ [`Y${i}`]: id })),
    inputs: Array.from({ length: INPUT_BITS }, (_, i) => ({ [`X${i}`]: `X${i}` })),
    outputs: Array.from({ length: OUTPUT_BITS }, (_, i) => ({ [`Y${i}`]: `Y${i}` })),
    spec, hash_contract: hashContract,
  };
  raw.md5 = digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec });
  return raw;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const usage = 'Usage: node scripts/generate-rgb-gray.mjs [OUTPUT_DIRECTORY] [--architecture parallel|shared]';
    let architecture = 'parallel', directory, architectureSeen = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--architecture' || args[i].startsWith('--architecture=')) {
        if (architectureSeen) throw new Error(usage);
        architectureSeen = true;
        architecture = args[i] === '--architecture' ? args[++i] : args[i].slice('--architecture='.length);
        if (!['parallel', 'shared'].includes(architecture)) throw new Error(usage);
      } else {
        if (args[i].startsWith('--') || directory !== undefined) throw new Error(usage);
        directory = args[i];
      }
    }
    const shared = architecture === 'shared';
    const outDir = resolve(directory ?? (shared ? 'artifacts/rgb-gray-3x3-shared' : 'artifacts/rgb-gray-3x3'));
    mkdirSync(outDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const generate = shared ? generateRgbGrayShared : generateRgbGray;
    for (const [profile, filename] of [
      ['pixel-suffixed', shared ? 'rgb-gray-216-72.shared.json' : 'rgb-gray-216-72.json'],
      ['numeric-compatibility', shared ? 'rgb-gray-216-72.shared.modelshow.json' : 'rgb-gray-216-72.modelshow.json'],
    ]) {
      const raw = generate({ profile, createdAt });
      const file = join(outDir, filename);
      const bytes = JSON.stringify(raw, null, 2) + '\n';
      let audit;
      if (shared) {
        const baseline = generateUnoptimizedRgbGrayShared({ profile, createdAt });
        audit = auditModels(baseline, raw);
        if (!audit.passed) throw new Error(`Full-model optimization gate failed: ${audit.error?.message ?? 'unknown failure'}`);
        const hash = value => createHash('sha256').update(value).digest('hex');
        const auditorPath = fileURLToPath(new URL('./audit-rgb-gray-ex.mjs', import.meta.url));
        const enginePath = fileURLToPath(new URL('../skills/jk-network-generator/scripts/engine.mjs', import.meta.url));
        audit.baseline_identity = { ...audit.baseline_identity, source: 'in-memory unoptimized generation', serialized_sha256: hash(JSON.stringify(baseline, null, 2) + '\n') };
        audit.model_identity = { ...audit.model_identity, path: file, file_sha256: hash(bytes) };
        audit.auditor_identity = { path: auditorPath, file_sha256: hash(readFileSync(auditorPath)), node_version: process.version };
        audit.engine_identity = { path: enginePath, file_sha256: hash(readFileSync(enginePath)) };
        audit.generated_at = new Date().toISOString();
      }
      writeFileSync(file, bytes);
      if (audit) writeFileSync(file.replace(/\.json$/, '.optimization.json'), JSON.stringify(audit, null, 2) + '\n');
      console.log(JSON.stringify({ file, md5: raw.md5, created_at: raw.created_at, nodes: raw.jk_bits,
        stateful: raw.initial_q['0'].length + raw.initial_q['1'].length,
        optimized_core: shared ? { shared_arithmetic_nodes: raw.spec.optimization.shared_arithmetic_nodes,
          ex_operations: raw.ex_operation_sum, preassembly_passed: raw.spec.optimization.preassembly_checks.passed } : raw.spec.optimization,
        ...(audit ? { optimization_audited_nodes: audit.coverage.audited_nodes, global_optimum_proven: audit.global_optimum_proven } : {}) }));
    }
    const examplePixels = [
      [0, 0, 0], [255, 255, 255], [255, 0, 0],
      [0, 255, 0], [0, 0, 255], [128, 128, 128],
      [255, 255, 0], [0, 255, 255], [255, 0, 255],
    ];
    const input = Object.fromEntries(examplePixels.flatMap((rgb, p) => rgb.flatMap((v, c) =>
      Array.from({ length: 8 }, (_, b) => [`X${24 * p + 8 * c + b}`, (v >> b) & 1]))));
    writeFileSync(join(outDir, 'example-input.json'), JSON.stringify(input, null, 2) + '\n');
    writeFileSync(join(outDir, 'example-expected.json'), JSON.stringify({
      rgb_pixels_row_major: examplePixels,
      grayscale_rows: [[0, 255, 77], [149, 29, 128], [226, 178, 106]],
    }, null, 2) + '\n');
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
