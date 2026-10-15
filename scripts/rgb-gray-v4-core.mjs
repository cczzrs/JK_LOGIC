import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseExpression, createSnapshot, compileModel } from '../skills/jk-network-generator/scripts/model.mjs';
import { JKEngine } from '../skills/jk-network-generator/scripts/engine.mjs';

const refs = ex => [...new Set(parseExpression(ex).flatMap(t => t.source ? [t.source] : []))];
const operations = ex => parseExpression(ex).length;
const token = (op, x) => typeof x === 'number' ? op + x : `${op}(${x})`;
const order = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

// A finite, exact shortest-expression search, including the required source mask.
// The leading J0 is mandatory and included in the returned operation count.
export function shortestExpression(variableCount, target, maxStates = 100000) {
  assert(variableCount >= 1 && variableCount <= 4);
  const rows = 1 << variableCount, all = (1 << rows) - 1;
  const columns = Array.from({ length: variableCount }, (_, i) => {
    let word = 0; for (let r = 0; r < rows; r++) word |= ((r >> i) & 1) << r; return word;
  });
  const required = (1 << variableCount) - 1;
  const choices = [{ value: 0, source: 0, label: '0' }, { value: all, source: 0, label: '1' },
    ...columns.map((value, i) => ({ value, source: 1 << i, label: `(Q${i})` }))];
  const start = { value: 0, used: 0, ex: 'J0' }, queue = [start], seen = new Set(['0:0']);
  for (let i = 0; i < queue.length; i++) {
    const state = queue[i];
    if (state.value === target && state.used === required)
      return { proven: true, ex: state.ex, operations: operations(state.ex), states: seen.size };
    for (const choice of choices) for (const op of ['J', 'K']) {
      const value = op === 'J' ? state.value & choice.value : state.value ^ choice.value;
      const used = state.used | choice.source, key = `${value}:${used}`;
      if (!seen.has(key)) {
        if (seen.size >= maxStates) return { proven: false, reason: 'state limit reached', states: seen.size };
        seen.add(key); queue.push({ value, used, ex: state.ex + op + choice.label });
      }
    }
  }
  return { proven: true, impossible: true, states: seen.size };
}

function truthWord(ex, inputs) {
  let word = 0;
  for (let bits = 0; bits < 1 << inputs.length; bits++) {
    let q = 0;
    for (const t of parseExpression(ex)) {
      const v = t.source ? (bits >> inputs.indexOf(t.source)) & 1 : t.constant;
      q = t.op === 'J' ? q & v : q ^ v;
    }
    word |= q << bits;
  }
  return word;
}

let checkedTemplates;
function verifyPrimitiveFIFO(name, count, expressions, outputIndexes, oracle) {
  const nodes = [
    ...Array.from({ length: count }, (_, i) => ({ id: 'Q' + i, ex: `J0K(X${i})` })),
    ...Array.from({ length: count }, (_, i) => ({ id: 'Q' + (count + i), ex: `J0K(Q${i})` })),
    ...expressions.map((ex, i) => ({ id: 'Q' + (2 * count + i), ex: ex.replace(/Q(\d+)/g, (_, index) => 'Q' + (count + Number(index))) })),
  ];
  const model = createSnapshot({ name: 'gray-core-preflight-' + name, input_bits: count, nodes,
    initial_q: { '0': nodes.slice(0, count).map(n => n.id), '1': [] },
    q_y: outputIndexes.map((i, bit) => ({ ['Y' + bit]: 'Q' + (2 * count + i) })) });
  const engine = new JKEngine(compileModel(model), { historyLimit: 0 });
  const vectors = [...Array.from({ length: 1 << count }, (_, i) => i), 0, 0, (1 << count) - 1, (1 << count) - 1];
  for (const bits of vectors) {
    engine.send(Object.fromEntries(Array.from({ length: count }, (_, i) => ['X' + i, (bits >> i) & 1])));
    const executions = new Map(), emitted = new Map();
    while (engine.length) {
      const event = engine.step(); assert.equal(event.type, 'execution');
      executions.set(event.node, (executions.get(event.node) ?? 0) + 1);
      for (const t of event.transfers) if (t.target.startsWith('Y')) {
        assert(!emitted.has(t.target)); emitted.set(t.target, t.value);
      }
    }
    assert.equal(executions.size, nodes.length);
    assert([...executions.values()].every(n => n === 1));
    assert([...engine.cache.values()].every(c => c.size === 0));
    const expected = oracle(Array.from({ length: count }, (_, i) => (bits >> i) & 1));
    expected.forEach((value, i) => assert.equal(emitted.get('Y' + i), value));
  }
  engine.reset(); assert.equal(engine.length, 0); assert.equal(engine.total, 0);
  assert([...engine.outputs.values()].every(v => v === null));
  return { passed: true, frames: vectors.length, repeated_values: true, every_node_once_per_frame: true,
    each_output_once_per_frame: true, empty_arrivals_after_each_frame: true, reset_without_spontaneous_tasks: true };
}

export function checkSmallStructures() {
  if (checkedTemplates) return structuredClone(checkedTemplates);
  const definitions = [
    ['copy', 'J0K(Q0)', 2, x => x[0]],
    ['not', 'J0K(Q0)K1', 3, x => x[0] ^ 1],
    ['and', 'J0K(Q0)J(Q1)', 3, x => x[0] & x[1]],
    ['xor', 'J0K(Q0)K(Q1)', 3, x => x[0] ^ x[1]],
    ['or', 'J0K(Q0)K1J(Q1)K(Q0)', 5, x => x[0] | x[1]],
    ['full_adder_carry_given_parity', 'J0K(Q0)K(Q2)J(Q1)K(Q0)', 5,
      x => ((x[0] ^ x[2]) & x[1]) ^ x[0]],
  ];
  const templates = definitions.map(([name, ex, expected, oracle]) => {
    const sources = refs(ex).sort(order), actual = truthWord(ex, sources);
    let expectedTruth = 0;
    for (let bits = 0; bits < 1 << sources.length; bits++) {
      const values = Array.from({ length: sources.length }, (_, i) => (bits >> i) & 1);
      expectedTruth |= oracle(values) << bits;
    }
    assert.equal(actual, expectedTruth, name);
    const minimum = shortestExpression(sources.length, actual);
    assert.equal(minimum.operations, expected, name);
    const fifo = verifyPrimitiveFIFO(name, sources.length, [ex], [0], values => [oracle(values)]);
    return { name, ex, cases: 1 << sources.length, minimum, sources, fifo };
  });
  // No flat expression of independent a,b,c computes majority. Even when sum
  // is offered as an additional source, majority is not in the expression
  // closure. A two-node sum+carry pair is therefore impossible in this class.
  const close = generators => {
    const seen = new Set([0]), queue = [0];
    for (let i = 0; i < queue.length; i++) for (const x of [0, 255, ...generators])
      for (const y of [queue[i] & x, queue[i] ^ x]) if (!seen.has(y)) { seen.add(y); queue.push(y); }
    return seen;
  };
  const direct = close([170, 204, 240]), withSum = close([170, 204, 240, 150]);
  assert(!direct.has(232)); assert(!withSum.has(232));
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
    const p = a ^ b, s = p ^ c, carry = ((a ^ c) & p) ^ a;
    assert.equal(s + 2 * carry, a + b + c);
    assert.equal(carry, ((b ^ c) & p) ^ b, 'Carry symmetry before composition');
  }
  checkedTemplates = {
    phase: 'before composition', templates, full_adder: { nodes: 3, operations: 11, cases: 8,
      minimum_nodes_proven: 3, scope: 'flat stateless J/K nodes; independent a,b,c; outputs sum and carry',
      direct_function_closure: direct.size, closure_with_sum: withSum.size,
      carry_symmetry_cases: 8,
      fifo: verifyPrimitiveFIFO('full-adder', 3,
        ['J0K(Q0)K(Q1)', 'J0K(Q3)K(Q2)', 'J0K(Q0)K(Q2)J(Q3)K(Q0)'], [1, 2],
        x => [(x[0] + x[1] + x[2]) & 1, (x[0] + x[1] + x[2]) >>> 1]) },
    event_contract: 'All operand sources are stateless, publish once per pixel, and each pixel is separated sufficiently to prevent arrival overwrite. All core nodes publish q=0/1.',
    global_optimum_proven: false,
  };
  return structuredClone(checkedTemplates);
}

class CoreBuilder {
  constructor(inputIds) { this.inputIds = inputIds; this.nodes = []; this.memo = new Map(); }
  emit(ex) {
    if (this.memo.has(ex)) return this.memo.get(ex);
    const id = 'T' + this.nodes.length;
    this.nodes.push({ id, ex }); this.memo.set(ex, id); return id;
  }
  not(a) { return typeof a === 'number' ? a ^ 1 : this.emit('J0' + token('K', a) + 'K1'); }
  xor(a, b) {
    if (a === b) return 0;
    if (a === 0) return b; if (b === 0) return a;
    if (a === 1) return this.not(b); if (b === 1) return this.not(a);
    [a, b] = [a, b].sort(order); return this.emit('J0' + token('K', a) + token('K', b));
  }
  and(a, b) {
    if (a === 0 || b === 0) return 0;
    if (a === 1 || a === b) return b; if (b === 1) return a;
    [a, b] = [a, b].sort(order); return this.emit('J0' + token('K', a) + token('J', b));
  }
  or(a, b) {
    if (a === 1 || b === 1) return 1;
    if (a === 0 || a === b) return b; if (b === 0) return a;
    [a, b] = [a, b].sort(order); return this.emit('J0' + token('K', a) + 'K1' + token('J', b) + token('K', a));
  }
  fullAdder(a, b, c) {
    const xs = [a, b, c];
    if (xs.includes(0)) { xs.splice(xs.indexOf(0), 1); return [this.xor(...xs), this.and(...xs)]; }
    if (xs.includes(1)) { xs.splice(xs.indexOf(1), 1); return [this.not(this.xor(...xs)), this.or(...xs)]; }
    if (a === b) return [c, a]; if (a === c) return [b, a]; if (b === c) return [a, b];
    const p = this.xor(a, b), sum = this.xor(p, c);
    const carry = this.emit('J0' + token('K', a) + token('K', c) + token('J', p) + token('K', a));
    return [sum, carry];
  }
  add(a, b, width) {
    let carry = 0; const out = [];
    for (let i = 0; i < width; i++) {
      if (i === width - 1) out.push(this.xor(this.xor(a[i] ?? 0, b[i] ?? 0), carry));
      else { const pair = this.fullAdder(a[i] ?? 0, b[i] ?? 0, carry); out.push(pair[0]); carry = pair[1]; }
    }
    return out;
  }
}

// Symbolic T references are construction handles only and never reach JSON.
const symbolicTokens = ex => [...ex.matchAll(/([JK])(0|1|\(([QT]\d+)\))/g)].map(m => ({ op: m[1], value: m[3] ? undefined : Number(m[2]), source: m[3], text: m[0] }));
const symbolicRefs = ex => [...new Set(symbolicTokens(ex).flatMap(t => t.source ? [t.source] : []))];
function prune(nodes, outputs) {
  const byId = new Map(nodes.map(n => [n.id, n])), live = new Set();
  const visit = id => { if (!byId.has(id) || live.has(id)) return; live.add(id); symbolicRefs(byId.get(id).ex).forEach(visit); };
  outputs.forEach(visit); return nodes.filter(n => live.has(n.id));
}

function inline(nodes, outputs, shareExpansion = false) {
  const outputSet = new Set(outputs), changes = [];
  nodes = prune(nodes, outputs).map(n => ({ ...n }));
  let progress = true;
  while (progress) {
    progress = false;
    for (const source of nodes) {
      if (outputSet.has(source.id)) continue;
      const consumers = nodes.filter(n => symbolicRefs(n.ex).includes(source.id));
      if (!consumers.length || !shareExpansion && consumers.length !== 1) continue;
      const replacements = [], inputTokens = symbolicTokens(source.ex);
      for (const target of consumers) {
        const targetTokens = symbolicTokens(target.ex);
        const positions = targetTokens.flatMap((t, i) => t.source === source.id ? [i] : []);
        const tokenReplacements = new Map();
        for (const position of positions) {
          const operation = targetTokens[position].op;
          let replacement;
          if (operation === 'K' && position === 1) replacement = source.ex.slice(2);
          else if (operation === 'K' && inputTokens.slice(1).every(t => t.op === 'K')) replacement = source.ex.slice(2);
          else if (operation === 'J' && inputTokens[1]?.op === 'K' && inputTokens.slice(2).every(t => t.op === 'J'))
            replacement = 'J' + inputTokens[1].text.slice(1) + inputTokens.slice(2).map(t => t.text).join('');
          if (replacement === undefined) break;
          tokenReplacements.set(position, replacement);
        }
        if (tokenReplacements.size !== positions.length) break;
        const ex = targetTokens.map((t, i) => tokenReplacements.get(i) ?? t.text).join('');
        if (symbolicTokens(ex).length > 64) break;
        replacements.push({ target, ex });
      }
      if (replacements.length !== consumers.length) continue;
      for (const { target, ex } of replacements) {
        changes.push({ removed: source.id, into: target.id, before: target.ex, after: ex }); target.ex = ex;
      }
      nodes = nodes.filter(n => n.id !== source.id); progress = true; break;
    }
  }
  return { nodes: prune(nodes, outputs), changes };
}

function shortenSymmetricCarries(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n])), changes = [];
  const parity = terms => {
    const odd = new Set();
    for (const value of terms) if (value !== '0') odd.has(value) ? odd.delete(value) : odd.add(value);
    return [...odd];
  };
  const terms = tokens => tokens.map(t => t.source ?? String(t.value));
  const k = x => x === '1' ? 'K1' : `K(${x})`;
  const evaluate = (ex, values) => symbolicTokens(ex).reduce((q, t) => {
    const v = t.source ? values[t.source] : t.value; return t.op === 'J' ? q & v : q ^ v;
  }, 0);
  // P = A XOR B establishes the symmetry of the three-input carry:
  // A XOR ((A XOR C) AND P) = B XOR ((B XOR C) AND P).
  // Only a literal parity definition of P is accepted. P is not treated as an
  // independent variable in this proof; all its parent variables are enumerated.
  let progress = true;
  while (progress) {
    progress = false;
    for (const node of nodes) {
      const ts = symbolicTokens(node.ex), ands = ts.flatMap((t, i) => t.op === 'J' && i > 0 ? [i] : []);
      if (ands.length !== 1) continue;
      const j = ands[0], source = byId.get(ts[j].source);
      if (!source || !ts.slice(1, j).every(t => t.op === 'K') || !ts.slice(j + 1).every(t => t.op === 'K')) continue;
      const ps = symbolicTokens(source.ex);
      if (!ps.slice(1).every(t => t.op === 'K')) continue;
      const a = terms(ts.slice(j + 1)), c = parity([...terms(ts.slice(1, j)), ...a]);
      const b = parity([...terms(ps.slice(1)), ...a]);
      const after = 'J0' + parity([...b, ...c]).map(k).join('') + ts[j].text + b.map(k).join('');
      if (symbolicTokens(after).length >= ts.length) continue;
      const independent = [...new Set([...symbolicRefs(node.ex), ...symbolicRefs(after), ...symbolicRefs(source.ex)])].filter(q => q !== source.id);
      assert(independent.length <= 16, 'Carry symmetry proof must be fully enumerated');
      for (let bits = 0; bits < 2 ** independent.length; bits++) {
        const values = Object.fromEntries(independent.map((q, i) => [q, (bits >> i) & 1]));
        values[source.id] = evaluate(source.ex, values);
        assert.equal(evaluate(node.ex, values), evaluate(after, values), 'Dependent carry symmetry');
      }
      changes.push({ id: node.id, before: node.ex, after, parity: { ...source },
        operations_saved: ts.length - symbolicTokens(after).length, before_sources: symbolicRefs(node.ex), after_sources: symbolicRefs(after),
        proof: { method: 'Exhaustive independent parent values with the referenced parity expression evaluated first',
          cases: 2 ** independent.length, independent_sources: independent,
          identity: 'A XOR ((A XOR C) AND P) = B XOR ((B XOR C) AND P), given P=A XOR B' } });
      node.ex = after; progress = true;
    }
  }
  return changes;
}

function construct(inputs, factored, shareExpansion = false) {
  const b = new CoreBuilder(inputs), columns = Array.from({ length: 17 }, () => []);
  const addTerm = (bits, shift) => bits.forEach((x, i) => { if (x !== 0 && i + shift < 16) columns[i + shift].push(x); });
  const [r, g, blue] = [inputs.slice(0, 8), inputs.slice(8, 16), inputs.slice(16, 24)];
  if (factored) {
    const rb = b.add(r, blue, 9);
    addTerm(r, 6); addTerm(blue, 4);
    for (const shift of [0, 2, 3]) addTerm(rb, shift);
    for (const shift of [1, 2, 4, 7]) addTerm(g, shift);
  } else for (const [bits, shifts] of [[r, [0, 2, 3, 6]], [g, [1, 2, 4, 7]], [blue, [0, 2, 3, 4]]])
    for (const shift of shifts) addTerm(bits, shift);
  columns[7].push(1);
  for (let i = 0; i < 16; i++) while (columns[i].length > 2) {
    const pair = b.fullAdder(...columns[i].splice(0, 3));
    if (pair[0] !== 0) columns[i].push(pair[0]); if (pair[1] !== 0) columns[i + 1].push(pair[1]);
  }
  const allBits = b.add(columns.slice(0, 16).map(c => c[0] ?? 0), columns.slice(0, 16).map(c => c[1] ?? 0), 16);
  const outputs = allBits.slice(8, 16), before = prune(b.nodes, outputs), result = inline(before, outputs, shareExpansion);
  return { ...result, outputs, before, factored, shareExpansion };
}

export function buildGrayCore(inputIds, startIndex) {
  assert(Array.isArray(inputIds) && inputIds.length === 24 && new Set(inputIds).size === 24);
  assert(inputIds.every(id => /^Q(?:0|[1-9]\d*)$/.test(id)));
  assert(Number.isSafeInteger(startIndex) && startIndex > Math.max(...inputIds.map(id => Number(id.slice(1)))));
  const preassembly = checkSmallStructures();
  const alternatives = [construct(inputIds, false), construct(inputIds, true), construct(inputIds, false, true), construct(inputIds, true, true)];
  alternatives.sort((a, b) => a.nodes.length - b.nodes.length || a.nodes.reduce((s, n) => s + symbolicTokens(n.ex).length, 0) - b.nodes.reduce((s, n) => s + symbolicTokens(n.ex).length, 0));
  const chosen = alternatives[0], map = new Map(chosen.nodes.map((n, i) => [n.id, 'Q' + (startIndex + i)]));
  const carryChanges = shortenSymmetricCarries(chosen.nodes);
  const remap = x => map.get(x) ?? x;
  const nodes = chosen.nodes.map(n => ({ id: remap(n.id), ex: n.ex.replace(/[QT]\d+/g, remap) }));
  const outputs = chosen.outputs.map(remap), depths = Object.fromEntries(inputIds.map(id => [id, 0]));
  const rewired = new Map(carryChanges.map(change => [remap(change.id), {
    ...change, id: remap(change.id), before: change.before.replace(/[QT]\d+/g, remap), after: change.after.replace(/[QT]\d+/g, remap),
    parity: { id: remap(change.parity.id), ex: change.parity.ex.replace(/[QT]\d+/g, remap) },
    before_sources: change.before_sources.map(remap), after_sources: change.after_sources.map(remap),
    proof: { ...change.proof, independent_sources: change.proof.independent_sources.map(remap) },
  }]));
  const minima = new Map(), nodeAudit = [];
  for (const node of nodes) {
    const sources = refs(node.ex); assert(sources.every(s => Object.hasOwn(depths, s)), node.id);
    depths[node.id] = 1 + Math.max(...sources.map(s => depths[s]));
    let minimum = { proven: false, reason: 'More than four independent sources; finite search not attempted' };
    if (sources.length <= 4) {
      const truth = truthWord(node.ex, sources), key = `${sources.length}:${truth}`;
      if (!minima.has(key)) minima.set(key, shortestExpression(sources.length, truth));
      minimum = minima.get(key);
      // The searched expression preserves the complete source set and is an
      // unconditional rewrite. This also catches any simplification exposed by inlining.
      if (minimum.operations < operations(node.ex)) {
        const old = node.ex;
        node.ex = minimum.ex.replace(/Q(\d+)/g, (_, i) => sources[Number(i)]);
        nodeAudit.push({ id: node.id, classification: 'stateless', pro: 'q=0/1', sources, barrier_sources: sources,
          before: old, after: node.ex, minimum, conclusion: 'shortened; exact full-source truth table' });
        continue;
      }
    } else if (operations(node.ex) === sources.length + 1) {
      minimum = { proven: true, operations: operations(node.ex), method: 'one mandatory J0 plus at least one occurrence of each required source' };
    }
    nodeAudit.push({ id: node.id, classification: 'stateless', pro: 'q=0/1', sources, barrier_sources: sources,
      before: node.ex, after: node.ex, minimum,
      conclusion: minimum.proven ? 'retained; shortest with fixed independent sources' : 'retained; minimum not proven' });
  }
  for (const row of nodeAudit) if (rewired.has(row.id)) {
    row.before = rewired.get(row.id).before; row.conditional_rewire = rewired.get(row.id);
    row.conclusion = 'shortened by proved carry symmetry using the referenced parity definition; '
      + (row.minimum.proven ? 'new EX shortest with its fixed independent sources' : 'new EX minimum not proven');
  }
  const usedInputs = new Set(nodes.flatMap(n => refs(n.ex)).filter(id => inputIds.includes(id)));
  assert.equal(usedInputs.size, 24);
  const consumers = new Map(nodes.map(n => [n.id, 0]));
  for (const node of nodes) for (const source of refs(node.ex)) if (consumers.has(source)) consumers.set(source, consumers.get(source) + 1);
  for (const source of outputs) consumers.set(source, consumers.get(source) + 1);
  assert([...consumers.values()].every(count => count >= 1));
  const fixedPoint = inline(nodes, outputs, true);
  assert.equal(fixedPoint.nodes.length, nodes.length, 'Remaining safe inline candidate after EX review');
  const duplicateKeys = new Map();
  for (const node of nodes) {
    const sources = refs(node.ex).sort(order);
    const key = sources.join(',') + ':' + (sources.length <= 4 ? truthWord(node.ex, sources) : node.ex);
    assert(!duplicateKeys.has(key), `Duplicate same-source function ${node.id}/${duplicateKeys.get(key)}`);
    duplicateKeys.set(key, node.id);
  }
  return { nodes, outputs, inputIds: [...inputIds], nextIndex: startIndex + nodes.length,
    depth: Math.max(...outputs.map(q => depths[q])), depths,
    audit: { preassembly, arithmetic: 'floor((77*R + 150*G + 29*B + 128)/256)',
      selected: chosen.factored ? '13*(R+B)+64*R+16*B+150*G+128' : 'expanded fixed coefficients with carry-save reduction',
      candidates: alternatives.map(x => ({ factored: x.factored, multi_consumer_inline: x.shareExpansion, nodes: x.nodes.length, before_inline: x.before.length,
        operations: x.nodes.reduce((sum, n) => sum + symbolicTokens(n.ex).length, 0) })),
      nodes: nodes.length, operations: nodes.reduce((sum, n) => sum + operations(n.ex), 0),
      inline_removed: chosen.before.length - chosen.nodes.length, rewrites: chosen.changes,
      dependent_carry_rewrites: [...rewired.values()],
      dependent_rewire_event_conditions: 'This is a DAG source-set rewrite, not an independent-source local equivalence. Every affected operand is stateless and emits once for each sufficiently separated pixel; the parity source depends on every substituted parent. Complete-model FIFO verification must confirm no inter-pixel arrival overwrite, all nodes execute once per pixel, all output events and storage writes, and empty arrival sets at the promised frame boundary.',
      carry_symmetry_fixed_point: true,
      node_audit: nodeAudit, minimum_proven_nodes: nodeAudit.filter(n => n.minimum.proven).length,
      whole_graph_checks: { acyclic: true, all_nodes_live: true, all_inputs_used: 24,
        safe_inline_fixed_point: true, duplicate_same_source_functions: 0,
        duplicate_check_scope: 'Exact truth functions for up to four independent sources; exact EX for larger nodes',
        required_source_shortest_search_limit: 4, larger_source_nodes_not_proven_shortest: nodeAudit.filter(n => !n.minimum.proven).length },
      global_optimum_proven: false,
      event_proof_scope: 'Acyclic all-stateless dataflow, one event per source per separated pixel. Algebraic inlining changes internal tasks; full-model FIFO validation is still required.' } };
}

export function compileCoreEvaluator(core) {
  const lines = core.inputIds.map((id, i) => `let ${id}=(rgb>>>${i})&1;`);
  for (const node of core.nodes) {
    lines.push(`let ${node.id}=0;`);
    for (const t of parseExpression(node.ex)) {
      const operand = t.source ?? t.constant;
      lines.push(`${node.id}${t.op === 'J' ? '&' : '^'}=${operand};`);
    }
  }
  lines.push('return ' + core.outputs.map((id, i) => `(${id}<<${i})`).join('|') + ';');
  return new Function('rgb', lines.join('\n'));
}

export function verifyGrayCore(core, count = 1 << 24) {
  const evaluate = compileCoreEvaluator(core), started = performance.now();
  assert(Number.isInteger(count) && count >= 0 && count <= 1 << 24);
  for (let rgb = 0; rgb < count; rgb++) {
    const expected = (77 * (rgb & 255) + 150 * ((rgb >>> 8) & 255) + 29 * (rgb >>> 16) + 128) >>> 8;
    const actual = evaluate(rgb);
    if (actual !== expected) throw new Error(`RGB ${rgb}: expected ${expected}, actual ${actual}`);
  }
  return { passed: true, cases: count, exhaustive: count === 1 << 24, elapsed_ms: performance.now() - started };
}

export function verifyGrayCoreFIFO(samples = 128) {
  assert(Number.isInteger(samples) && samples >= 1);
  const inputIds = Array.from({ length: 24 }, (_, i) => 'Q' + (24 + i)), core = buildGrayCore(inputIds, 48);
  const inputs = Array.from({ length: 24 }, (_, i) => ({ id: 'Q' + i, ex: `J0K(X${i})` }));
  const nodes = [...inputs, ...inputIds.map((id, i) => ({ id, ex: `J0K(Q${i})` })), ...core.nodes];
  const model = createSnapshot({ name: 'gray-core-fifo-verification', input_bits: 24, nodes,
    initial_q: { '0': inputs.map(n => n.id), '1': [] }, q_y: core.outputs.map((id, i) => ({ ['Y' + i]: id })) });
  const engine = new JKEngine(compileModel(model), { historyLimit: 0 });
  let seed = 0x431021, peak = 0, count = 0;
  for (let i = 0; i < samples + 4; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const rgb = i < 2 ? 0 : i < 4 ? 0xffffff : seed & 0xffffff;
    const previous = engine.total, emitted = new Map(), executed = new Map();
    const data = Object.fromEntries(Array.from({ length: 24 }, (_, bit) => ['X' + bit, (rgb >>> bit) & 1]));
    engine.send(data);
    while (engine.length) {
      peak = Math.max(peak, engine.length); const event = engine.step();
      assert.equal(event.type, 'execution'); executed.set(event.node, (executed.get(event.node) ?? 0) + 1);
      for (const transfer of event.transfers) if (transfer.target.startsWith('Y')) {
        assert(!emitted.has(transfer.target)); emitted.set(transfer.target, transfer.value);
      }
    }
    assert.equal(engine.total - previous, nodes.length); assert([...executed.values()].every(n => n === 1));
    assert([...engine.cache.values()].every(c => c.size === 0)); assert.equal(emitted.size, 8);
    const gray = [...emitted].reduce((value, [id, bit]) => value | (bit << Number(id.slice(1))), 0);
    assert.equal(gray, (77 * (rgb & 255) + 150 * ((rgb >>> 8) & 255) + 29 * (rgb >>> 16) + 128) >>> 8);
    count++;
  }
  engine.reset(); assert.equal(engine.total, 0); assert.equal(engine.length, 0);
  return { passed: true, frames: count, core_nodes_per_frame: core.nodes.length, full_fixture_nodes_per_frame: nodes.length,
    every_node_once_per_frame: true, every_output_once_per_frame: true, empty_arrivals_after_frames: true,
    repeated_zero_and_white: true, reset_without_tasks: true, queue_peak: peak };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const core = buildGrayCore(Array.from({ length: 24 }, (_, i) => 'Q' + i), 24);
  console.log(JSON.stringify({ nodes: core.nodes.length, operations: core.audit.operations, depth: core.depth,
    candidates: core.audit.candidates, preassembly: core.audit.preassembly,
    minimum_proven_nodes: core.audit.minimum_proven_nodes, verification: verifyGrayCore(core),
    fifo_verification: verifyGrayCoreFIFO() }, null, 2));
}
