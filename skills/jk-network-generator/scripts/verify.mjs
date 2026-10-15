import { readFileSync, writeFileSync } from 'node:fs';
import { assertSeparateFiles } from './files.mjs';
import { pathToFileURL } from 'node:url';
import { compileModel, JKEngine } from './engine.mjs';
import {
  digest, fullWidth, unsignedContract, SUPPORTED_OPERATIONS, specificationPath,
  STATELESS_ARCHITECTURE, STATEFUL_ARCHITECTURE,
} from './generate.mjs';

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const BOUNDARY = 'JKRD V4 static snapshots; complete input vectors, both FIFOs drained before the next send; bounded continuous executions from declared initial state. No proof of arbitrary interleaving, all state trajectories, full runtime checkpoint continuity or global optimality.';

function checkArchitecture(model, architecture) {
  assert(typeof architecture === 'string' && architecture.trim().length > 0, 'Missing spec.architecture');
  if (![STATELESS_ARCHITECTURE, STATEFUL_ARCHITECTURE].includes(architecture)) return;
  const states = model.nodes.filter(n => n.initial !== null && !n.input);
  if (architecture === STATELESS_ARCHITECTURE) assert(states.length === 0, 'Arithmetic DAG contains unexpected saved state');
  else {
    const outputSources = new Set(model.outputs.map(o => o.source));
    assert(states.length === model.outputs.length && outputSources.size === states.length && states.every(n => outputSources.has(n.id)), 'Saved output nodes do not match output mappings');
    for (const n of states) {
      const [reset, source] = n.tokens;
      assert(n.initial === 0 && n.tokens.length === 2 && reset.text === 'J0' && source.op === 'K' && source.source?.startsWith('Q') && model.byId.get(source.source)[0].initial === null,
        `Saved output ${n.id} must initialize to 0 and execute J0K(stateless source)`);
    }
  }
}

/** Full V4 validation plus the separate two-operand arithmetic profile. */
export function validate(raw, spec) {
  const model = compileModel(raw);
  assert(spec && spec.signed === false && spec.bit_order === 'LSB-first', 'Missing separate unsigned LSB-first spec; use MODEL.spec.json or --spec FILE');
  assert(spec.model_md5 === raw.md5 && spec.model_format_md5 === raw.format_md5, 'Specification is not bound to this snapshot');
  assert(SUPPORTED_OPERATIONS.includes(spec.operation), 'Unsupported independent oracle');
  assert([spec.a_bits, spec.b_bits].every(n => Number.isInteger(n) && n >= 1 && n <= 32), 'Invalid operand width');
  const width = fullWidth(spec.operation, spec.a_bits, spec.b_bits);
  assert(spec.output_bits === width && raw.output_bits === width && raw.input_bits === spec.a_bits + spec.b_bits, 'Port width mismatch');
  assert(!Object.hasOwn(spec, 'input_bits') || spec.input_bits === raw.input_bits, 'spec.input_bits mismatch');
  for (const [key, value] of Object.entries(unsignedContract(spec.a_bits, spec.b_bits))) {
    if (key !== 'architecture') assert(spec[key] === value, `Unsupported spec.${key}; expected ${JSON.stringify(value)}`);
  }
  assert(Object.values(raw.FIFOS).every(q => q.length === 0), 'Arithmetic verification requires an initial snapshot with empty FIFOS; validate resumed tasks with a dedicated state/event oracle');
  checkArchitecture(model, spec.architecture);
  return model;
}

export function expected(operation, a, b) {
  switch (operation) {
    case 'mul': return a * b;
    case 'add': return a + b;
    case 'and': return a & b;
    case 'or': return a | b;
    case 'xor': return a ^ b;
    default: throw new Error(`Unsupported independent oracle: ${String(operation)}`);
  }
}

/** Verify one persistent run, followed by reset and JSON round-trip boundary runs.
 * Throws on failure; error.report contains a serializable partial result for CLI
 * output and callers that need coverage or a failing input.
 */
export function verify(raw, { samples = null, spec } = {}) {
  const coverage = { truth_table_cases: 0, repeated_send_cases: 0, reset_cases: 0, reload_cases: 0 };
  let phase = 'validation', counterexample = null, executions = 0, peak = 0;
  const mode = samples === null ? 'exhaustive' : 'sampled';
  let combinations = null;
  try {
    const model = validate(raw, spec), totalBits = spec.a_bits + spec.b_bits;
    combinations = 1n << BigInt(totalBits);
    assert(samples !== null || totalBits <= 16, 'Exhaustive domain exceeds 65,536; explicitly request --samples N, or implement a SAT/miter proof');
    if (samples !== null) assert(Number.isInteger(samples) && samples > 0 && samples <= 1000000, 'samples must be 1..1000000');
    const engineOptions = { historyLimit: 0 };
    let engine = new JKEngine(model, engineOptions);
    const aMask = (1n << BigInt(spec.a_bits)) - 1n, bMask = (1n << BigInt(spec.b_bits)) - 1n;
    const seen = new Set();
    function check(a, b, coverageKey) {
      const input = {};
      for (let i = 0; i < raw.input_bits; i++) input['X' + i] = Number(((i < spec.a_bits ? a : b) >> BigInt(i < spec.a_bits ? i : i - spec.a_bits)) & 1n);
      const before = engine.total, publications = new Map();
      const wanted = expected(spec.operation, a, b);
      counterexample = { a: a.toString(), b: b.toString(), expected: wanted.toString(), actual: null, output_publications: {} };
      try {
        engine.send(input);
        while (engine.length) {
          peak = Math.max(peak, engine.length);
          assert(engine.total - before < Math.max(1000, model.nodes.length * 20), `Nonterminating/repeated execution at ${a},${b}`);
          const event = engine.step();
          for (const transfer of event.transfers) if (transfer.target.startsWith('Y')) publications.set(transfer.target, (publications.get(transfer.target) ?? 0) + 1);
        }
        let actual = 0n;
        for (let i = 0; i < raw.output_bits; i++) {
          const id = 'Y' + i;
          assert(publications.get(id) === 1, `Output ${id} not freshly published exactly once at ${a},${b}`);
          actual |= BigInt(engine.outputs.get(id)) << BigInt(i);
        }
        counterexample.actual = actual.toString();
        assert(actual === wanted, `Counterexample A=${a} B=${b}: got ${actual}, expected ${wanted}`);
        assert([...engine.cache.values()].every(cache => cache.size === 0), `Unconsumed arrivals at ${a},${b}`);
        coverage[coverageKey]++;
        counterexample = null;
      } finally {
        executions += engine.total - before;
        if (counterexample) counterexample.output_publications = Object.fromEntries(publications);
      }
    }
    function unique(a, b) {
      const key = a + ',' + b;
      if (!seen.has(key)) { seen.add(key); check(a, b, 'truth_table_cases'); }
    }
    phase = mode;
    if (samples === null) {
      for (let a = 0n; a <= aMask; a++) for (let b = 0n; b <= bMask; b++) check(a, b, 'truth_table_cases');
    } else {
      const as = [0n, 1n, aMask, aMask >> 1n], bs = [0n, 1n, bMask, bMask >> 1n];
      for (const a of as) for (const b of bs) unique(a, b);
      for (let i = 0; i < spec.a_bits; i++) unique(1n << BigInt(i), bMask);
      for (let i = 0; i < spec.b_bits; i++) unique(aMask, 1n << BigInt(i));
      let seed = 0x12345678;
      const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return BigInt(seed >>> 0); };
      for (let i = 0; i < samples; i++) unique(rand() & aMask, rand() & bMask);
    }
    // Identical values must still trigger. The truth-table/sample and repeated
    // phases share one engine and have no reset between any vectors.
    phase = 'repeated-send';
    check(aMask, bMask, 'repeated_send_cases');
    check(aMask, bMask, 'repeated_send_cases');
    check(0n, 0n, 'repeated_send_cases');
    const boundaryVectors = [[0n, 0n], [aMask, bMask], [1n, 1n], [aMask, 0n], [0n, bMask]];
    phase = 'reset';
    engine.reset();
    assert(engine.total === 0 && engine.length === 0 && [...engine.outputs.values()].every(v => v === null) && [...engine.cache.values()].every(cache => cache.size === 0), 'Reset did not clear runtime queues, outputs and arrivals');
    assert(model.nodes.filter(n => n.initial !== null).every(n => engine.q.get(n.id) === n.initial), 'Reset did not restore declared initial q');
    for (const [a, b] of boundaryVectors) check(a, b, 'reset_cases');
    phase = 'reload';
    const reloaded = JSON.parse(JSON.stringify(raw));
    engine = new JKEngine(validate(reloaded, spec), engineOptions);
    for (const [a, b] of boundaryVectors) check(a, b, 'reload_cases');
    return {
      passed: true, model_md5: raw.md5, model_format_md5: raw.format_md5, specification_md5: digest(spec), operation: spec.operation,
      operand_bits: [spec.a_bits, spec.b_bits], output_bits: raw.output_bits, nodes: model.nodes.length,
      stateful_nodes: model.nodes.filter(n => n.initial !== null).length,
      self_reference_nodes: model.nodes.filter(n => n.sources.includes(n.id)).length,
      mode, domain_combinations: combinations.toString(), ...coverage, executions, peak_queue: peak,
      checks: [
        'actual Xi.FIFO/Qi.FIFO engine, no reset between truth-table/sample and repeated-send vectors',
        'fresh output publication exactly once per send',
        'all output bits equal independent BigInt oracle',
        'queue drained and arrival caches empty',
        'reset restores initial runtime state, followed by five boundary vectors',
        'JSON serialization/reparse and recompilation, followed by five boundary vectors',
      ],
      boundary: BOUNDARY,
    };
  } catch (error) {
    error.report = {
      passed: false, model_md5: typeof raw?.md5 === 'string' ? raw.md5 : null,
      operation: spec?.operation ?? null, mode, phase, error: error.message,
      domain_combinations: combinations?.toString() ?? null, coverage, counterexample,
      executions, peak_queue: peak, boundary: BOUNDARY,
    };
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, report, ...flags] = process.argv.slice(2);
  let canWriteReport = false, raw = null, phase = 'arguments';
  try {
    assert(file && report, 'Usage: node verify.mjs MODEL.json REPORT.json [--spec SPEC.json] [--samples N]');
    let specFile = specificationPath(file), samples = null;
    const seenFlags = new Set();
    for (let i = 0; i < flags.length; i += 2) {
      assert(['--spec', '--samples'].includes(flags[i]) && flags[i + 1] && !seenFlags.has(flags[i]), 'Invalid or duplicate CLI option');
      seenFlags.add(flags[i]);
      if (flags[i] === '--spec') specFile = flags[i + 1];
      else samples = Number(flags[i + 1]);
    }
    phase = 'report-path';
    assertSeparateFiles(file, report);
    assertSeparateFiles(specFile, report);
    canWriteReport = true;
    phase = 'read-model';
    raw = JSON.parse(readFileSync(file, 'utf8'));
    phase = 'read-specification';
    const spec = JSON.parse(readFileSync(specFile, 'utf8'));
    const result = verify(raw, { samples, spec });
    phase = 'write-report';
    writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    const failure = error.report ?? {
      passed: false, model_md5: typeof raw?.md5 === 'string' ? raw.md5 : null,
      phase, error: error.message,
      coverage: { truth_table_cases: 0, repeated_send_cases: 0, reset_cases: 0, reload_cases: 0 },
      counterexample: null,
    };
    if (canWriteReport && phase !== 'write-report') {
      try { writeFileSync(report, JSON.stringify(failure, null, 2) + '\n'); }
      catch (writeError) { console.error(`Cannot write failure report: ${writeError.message}`); }
    }
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}
