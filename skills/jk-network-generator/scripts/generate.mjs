import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseExpression } from './engine.mjs';

export const SUPPORTED_OPERATIONS = Object.freeze(['mul', 'add', 'and', 'or', 'xor']);
export const INPUT_PROTOCOL = 'Send every input bit, then drain FIFO before the next vector; no request isolation is implied.';
// These descriptive values are retained for compatibility with existing model MD5s.
// "registers" here names JK output-state nodes, not physical hardware.
export const STATELESS_ARCHITECTURE = 'stateless DAG';
export const STATEFUL_ARCHITECTURE = 'stateless arithmetic core with stateful self-feedback output registers';
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const canonical = x => Array.isArray(x)
  ? '[' + x.map(canonical).join(',') + ']'
  : x && typeof x === 'object'
    ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'
    : JSON.stringify(x);
export const digest = x => createHash('md5').update(canonical(x)).digest('hex');
export const fullWidth = (operation, aBits, bBits) => operation === 'mul'
  ? aBits + bBits : Math.max(aBits, bBits) + (operation === 'add' ? 1 : 0);
export function unsignedContract(aBits, bBits, statefulOutput = false) {
  return {
    architecture: statefulOutput ? STATEFUL_ARCHITECTURE : STATELESS_ARCHITECTURE,
    signed: false,
    bit_order: 'LSB-first',
    a_inputs: `X0..X${aBits - 1}`,
    b_inputs: `X${aBits}..X${aBits + bBits - 1}`,
    output_encoding: 'unsigned binary; Y0 is LSB',
    input_protocol: INPUT_PROTOCOL,
  };
}
export function metrics(nodes) {
  const tokens = nodes.map(n => parseExpression(n.ex));
  return {
    jk_bits_max: nodes.length, jk_bits: nodes.length,
    ex_source_max: Math.max(0, ...tokens.map(ts => new Set(ts.filter(t => t.source).map(t => t.source)).size)),
    ex_operation_max: Math.max(0, ...tokens.map(ts => ts.length)),
    ex_source_sum: tokens.reduce((sum, ts) => sum + ts.filter(t => t.source).length, 0),
    ex_operation_sum: tokens.reduce((sum, ts) => sum + ts.length, 0),
  };
}

/** Boolean-operation builder. Signals are Xi / previously emitted Qi, or numeric 0/1.
 * Primitive expressions are stateless. finish() packages two unsigned operands
 * under the complete-vector/drain protocol; it is not a general state-machine encoder.
 */
export class Builder {
  constructor(optimize = true) {
    assert(typeof optimize === 'boolean', 'optimize must be boolean');
    this.nodes = [];
    this.memo = new Map();
    this.referencedInputs = new Set();
    this.optimize = optimize;
  }
  signal(x) {
    assert(x === 0 || x === 1 || typeof x === 'string' && /^[XQ](0|[1-9]\d*)$/.test(x), `Invalid signal ${String(x)}; expected numeric 0/1, Xi or existing Qi`);
    if (typeof x === 'string') {
      const index = Number(x.slice(1));
      assert(Number.isSafeInteger(index), `Invalid signal index ${x}`);
      if (x.startsWith('Q')) assert(index < this.nodes.length && this.nodes[index]?.id === x, `Unknown Builder signal ${x}`);
      else this.referencedInputs.add(x);
    }
    return x;
  }
  bitArray(bits, label) {
    assert(Array.isArray(bits), `${label} must be an array of signals`);
    for (let i = 0; i < bits.length; i++) this.signal(bits[i]);
  }
  emit(ex) {
    const tokens = parseExpression(ex);
    assert(tokens[0].text === 'J0', 'Builder.emit only constructs stateless expressions beginning with J0');
    for (const token of tokens) if (token.source) this.signal(token.source);
    if (this.optimize && this.memo.has(ex)) return this.memo.get(ex);
    const id = 'Q' + this.nodes.length;
    this.nodes.push({ id, ex });
    this.memo.set(ex, id);
    return id;
  }
  token(op, x) {
    assert(op === 'J' || op === 'K', 'Invalid operation token; expected J or K');
    this.signal(x);
    return x === 0 || x === 1 ? op + x : `${op}(${x})`;
  }
  not(a) {
    this.signal(a);
    if (typeof a === 'number') return 1 - a;
    return this.emit('J0' + this.token('K', a) + 'K1');
  }
  and(a, b) {
    this.signal(a); this.signal(b);
    if (typeof a === 'number' && typeof b === 'number') return a & b;
    if (this.optimize) {
      if (a === 0 || b === 0) return 0;
      if (a === 1) return b;
      if (b === 1 || a === b) return a;
      [a, b] = [a, b].sort();
    }
    return this.emit('J0' + this.token('K', a) + this.token('J', b));
  }
  xor(a, b) {
    this.signal(a); this.signal(b);
    if (typeof a === 'number' && typeof b === 'number') return a ^ b;
    if (this.optimize) {
      if (a === 0) return b;
      if (b === 0) return a;
      if (a === b) return 0;
      if (a === 1) return this.not(b);
      if (b === 1) return this.not(a);
      [a, b] = [a, b].sort();
    }
    return this.emit('J0' + this.token('K', a) + this.token('K', b));
  }
  or(a, b) {
    this.signal(a); this.signal(b);
    if (typeof a === 'number' && typeof b === 'number') return a | b;
    if (this.optimize) {
      if (a === 1 || b === 1) return 1;
      if (a === 0) return b;
      if (b === 0 || a === b) return a;
      [a, b] = [a, b].sort();
    }
    return this.emit('J0' + this.token('K', a) + 'K1' + this.token('J', b) + this.token('K', a));
  }
  mux(s, a, b) { return this.xor(a, this.and(s, this.xor(a, b))); } // s=0 -> a; s=1 -> b
  fullAdder(a, b, c) {
    const p = this.xor(a, b);
    return [this.xor(p, c), this.xor(this.and(a, b), this.and(p, c))];
  }
  add(a, b, width) {
    this.bitArray(a, 'a'); this.bitArray(b, 'b');
    assert(Number.isInteger(width) && width >= 1 && width <= 64, 'Builder.add width must be 1..64');
    assert(a.length <= width && b.length <= width, 'Builder.add width cannot discard supplied operand bits');
    const out = [];
    let carry = 0;
    for (let i = 0; i < width; i++) {
      const x = a[i] ?? 0, y = b[i] ?? 0;
      if (i === width - 1) out.push(this.xor(this.xor(x, y), carry));
      else {
        const [sum, nextCarry] = this.fullAdder(x, y, carry);
        out.push(sum); carry = nextCarry;
      }
    }
    return out;
  }
  finish(bits, spec, statefulOutput = false) {
    assert(spec && typeof spec === 'object' && !Array.isArray(spec), 'finish spec must be an object');
    assert(typeof statefulOutput === 'boolean', 'statefulOutput must be boolean');
    assert(typeof spec.operation === 'string' && spec.operation.trim().length > 0, 'spec.operation must be a nonempty string');
    assert([spec.a_bits, spec.b_bits].every(n => Number.isInteger(n) && n >= 1 && n <= 32), 'Each operand width must be 1..32');
    assert(Number.isInteger(spec.output_bits) && spec.output_bits >= 1 && spec.output_bits <= 64, 'spec.output_bits must be 1..64');
    this.bitArray(bits, 'Output bits');
    assert(bits.length === spec.output_bits, 'Output bit count does not match spec.output_bits');
    if (SUPPORTED_OPERATIONS.includes(spec.operation)) {
      assert(spec.output_bits === fullWidth(spec.operation, spec.a_bits, spec.b_bits), 'Supported operations require full-width output_bits');
    }
    const contract = unsignedContract(spec.a_bits, spec.b_bits, statefulOutput);
    for (const [key, value] of Object.entries(contract)) {
      assert(!Object.hasOwn(spec, key) || spec[key] === value, `Conflicting spec.${key}; finish uses ${JSON.stringify(value)}`);
    }
    const inputBits = spec.a_bits + spec.b_bits;
    assert(!Object.hasOwn(spec, 'input_bits') || spec.input_bits === inputBits, 'Conflicting spec.input_bits');
    for (const key of ['nodes', 'initial_q', 'q_y', 'inputs', 'outputs']) {
      assert(!Object.hasOwn(spec, key), `spec.${key} cannot override Builder-managed model structure or ports`);
    }
    // Validate every supplied reference before pruning: even a folded-away invalid
    // operand must not silently change the meaning of the user's specification.
    for (const x of [...this.referencedInputs, ...bits, ...this.nodes.flatMap(n => parseExpression(n.ex).flatMap(t => t.source ? [t.source] : []))]) {
      this.signal(x);
      if (typeof x === 'string' && x.startsWith('X')) assert(Number(x.slice(1)) < inputBits, `Input signal ${x} outside declared operands`);
    }
    // Constants need an input arrival on every complete-vector send. A pure J0
    // expression would publish only at initialization.
    let outputs = bits.map(x => typeof x === 'number'
      ? this.emit('J0K(X0)J0' + (x ? 'K1' : ''))
      : x.startsWith('X') ? this.emit('J0' + this.token('K', x)) : x);
    const stateIds = [];
    if (statefulOutput) outputs = outputs.map(source => {
      const id = 'Q' + this.nodes.length;
      this.nodes.push({ id, ex: `K(${id})K(${source})` });
      stateIds.push(id);
      return id;
    });
    const byId = new Map(this.nodes.map(n => [n.id, n])), live = new Set();
    const visit = id => {
      if (live.has(id)) return;
      live.add(id);
      for (const token of parseExpression(byId.get(id).ex)) if (token.source?.startsWith('Q')) visit(token.source);
    };
    outputs.forEach(visit);
    const used = this.nodes.filter(n => live.has(n.id));
    const remap = new Map(used.map((n, i) => [n.id, 'Q' + i]));
    const nodes = used.map(n => ({ id: remap.get(n.id), ex: n.ex.replace(/Q\d+/g, source => remap.get(source)) }));
    const raw = {
      name: `${spec.operation}-${spec.a_bits}x${spec.b_bits}-unsigned-${spec.output_bits}bit`,
      format: 'jk-logic-structure-V3.1.0', created_at: new Date().toISOString(),
      input_bits: inputBits, output_bits: spec.output_bits, ...metrics(nodes), nodes,
      initial_q: { '0': stateIds.map(id => remap.get(id)), '1': [] },
      q_y: outputs.map((q, i) => ({ ['Y' + i]: remap.get(q) })),
      inputs: Array.from({ length: inputBits }, (_, i) => ({ ['X' + i]: 'X' + i })),
      outputs: bits.map((_, i) => ({ ['Y' + i]: 'Y' + i })),
      spec: { ...spec, ...contract },
      hash_contract: 'md5 = lowercase MD5 of UTF-8 recursively key-sorted JSON of {nodes, initial_q, q_y, spec}; array order retained',
    };
    raw.md5 = digest({ nodes: raw.nodes, initial_q: raw.initial_q, q_y: raw.q_y, spec: raw.spec });
    return raw;
  }
}

export function generate(operation, aBits, bBits, optimize = true, statefulOutput = false) {
  assert(SUPPORTED_OPERATIONS.includes(operation), 'Supported CLI operations: mul/add/and/or/xor. Use Builder for other Boolean node structures and supply an independent verifier.');
  assert([aBits, bBits].every(n => Number.isInteger(n) && n >= 1 && n <= 32), 'Each operand width must be 1..32');
  const builder = new Builder(optimize);
  const a = Array.from({ length: aBits }, (_, i) => 'X' + i);
  const b = Array.from({ length: bBits }, (_, i) => 'X' + (aBits + i));
  const width = fullWidth(operation, aBits, bBits);
  let bits;
  if (operation === 'mul') {
    // Compress each bit-weight column from three signals to sum/carry, then add
    // the remaining two vectors with carry propagation.
    const columns = Array.from({ length: width + 1 }, () => []);
    for (let i = 0; i < aBits; i++) for (let j = 0; j < bBits; j++) columns[i + j].push(builder.and(a[i], b[j]));
    for (let i = 0; i < width; i++) while (columns[i].length > 2) {
      const [sum, carry] = builder.fullAdder(...columns[i].splice(0, 3));
      columns[i].push(sum); columns[i + 1].push(carry);
    }
    bits = builder.add(columns.slice(0, width).map(c => c[0] ?? 0), columns.slice(0, width).map(c => c[1] ?? 0), width);
  } else if (operation === 'add') bits = builder.add(a, b, width);
  else bits = Array.from({ length: width }, (_, i) => builder[operation](a[i] ?? 0, b[i] ?? 0));
  return builder.finish(bits, { operation, a_bits: aBits, b_bits: bBits, output_bits: width }, statefulOutput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [op, a, b, file, ...flags] = process.argv.slice(2);
    assert(file && flags.every(f => ['--no-opt', '--stateful-output'].includes(f)), 'Usage: node generate.mjs mul|add|and|or|xor A_BITS B_BITS OUTPUT.json [--no-opt] [--stateful-output]');
    const model = generate(op, Number(a), Number(b), !flags.includes('--no-opt'), flags.includes('--stateful-output'));
    writeFileSync(file, JSON.stringify(model, null, 2) + '\n');
    console.error(`Wrote ${file}: ${model.nodes.length} JK nodes`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
