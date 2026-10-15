import { createHash } from 'node:crypto';

/** Implementation of the static JKRD V4.0.0 snapshot contract. */
export const CONFIG = Object.freeze({
  format: 'jk-logic-structure-V4.0.0',
  ports: Object.freeze({ maximum: 216 }),
  propagation: Object.freeze({ default: 'q=0/1', allowed: Object.freeze(['q=0/1', 'q=0', 'q=1', 'q=']) }),
  queues: Object.freeze([
    Object.freeze({ name: 'Xi.FIFO', priority: 1 }),
    Object.freeze({ name: 'Qi.FIFO', priority: 5 }),
  ]),
  display: Object.freeze({ show: '5D' }),
  runtime: Object.freeze({ historyLimit: 400 }),
});
export const assert = (ok, message) => { if (!ok) throw new Error(message); };
export const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const order = (a, b) => {
  assert(/^[XQY](0|[1-9]\d*)$/.test(a) && /^[XQY](0|[1-9]\d*)$/.test(b), 'ID 必须为 X/Q/Y 加无前导零的编号');
  const x = BigInt(a.slice(1)), y = BigInt(b.slice(1));
  return x < y ? -1 : x > y ? 1 : 0;
};
export const canonical = x => Array.isArray(x)
  ? '[' + x.map(canonical).join(',') + ']'
  : object(x)
    ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}'
    : JSON.stringify(x);
export const digest = x => createHash('md5').update(canonical(x), 'utf8').digest('hex');
export const emptyFifos = () => Object.fromEntries(CONFIG.queues.map(q => [q.name, []]));
export const identityPorts = (prefix, length) => Array.from({ length }, (_, i) => ({ [prefix + i]: prefix + i }));

export function parseExpression(ex) {
  assert(typeof ex === 'string' && ex.length > 0, 'ex 必须为非空字符串');
  const tokens = [], re = /([JK])(?:([01])|\(([XQ](?:0|[1-9]\d*))\))/y;
  let pos = 0;
  while (pos < ex.length) {
    re.lastIndex = pos;
    const match = re.exec(ex);
    assert(match, `ex 第 ${pos + 1} 个字符无法解析：${ex.slice(pos, pos + 12)}`);
    tokens.push({ op: match[1], constant: match[2] === undefined ? null : Number(match[2]), source: match[3] ?? null, text: match[0], index: tokens.length });
    pos = re.lastIndex;
  }
  return tokens;
}

export function metrics(nodes) {
  let sourcesMax = 0, sourcesSum = 0, operationsMax = 0, operationsSum = 0;
  for (const n of nodes) {
    const tokens = parseExpression(n.ex);
    const count = new Set(tokens.flatMap(t => t.source && t.source !== n.id ? [t.source] : [])).size;
    sourcesMax = Math.max(sourcesMax, count); sourcesSum += count;
    operationsMax = Math.max(operationsMax, tokens.length); operationsSum += tokens.length;
  }
  return { jk_bits: nodes.length, ex_source_max: sourcesMax, ex_operation_max: operationsMax, ex_source_sum: sourcesSum, ex_operation_sum: operationsSum };
}

const normalizedNodes = nodes => nodes.map(({ id, ex, pro }) => pro === undefined || pro === CONFIG.propagation.default ? { id, ex } : { id, ex, pro });
export function fingerprints(raw) {
  const base = { format: raw.format, nodes: normalizedNodes(raw.nodes), initial_q: raw.initial_q, q_y: raw.q_y };
  return { format_md5: digest(base), md5: digest({ ...base, FIFOS: raw.FIFOS, created_at: raw.created_at }) };
}
export function createdAt(nanoseconds = BigInt(Date.now()) * 1000000n) {
  return new Date(Number(nanoseconds / 1000000n)).toISOString().slice(0, 13) + ':' + nanoseconds;
}
function checkTime(value) {
  assert(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:(0|[1-9]\d*)$/.test(value), 'created_at 必须为 UTC 小时与 Unix 纳秒字符串');
  const [hour, ns] = value.split(':');
  const date = new Date(Number(BigInt(ns) / 1000000n));
  assert(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 13) === hour && createdAt(BigInt(ns)) === value, 'created_at 两部分必须对应同一 UTC 时刻且无额外字符');
}
function fields(value, required, optional, label) {
  assert(object(value), `${label} 必须为对象`);
  for (const key of required) assert(Object.hasOwn(value, key), `${label} 缺少字段 ${key}`);
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), `${label} 不接受未定义字段 ${key}`);
}
const bit = value => value === 0 || value === 1;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const TOP_FIELDS = ['name', 'md5', 'format', 'format_md5', 'created_at', 'input_bits', 'jk_bits_max', 'jk_bits', 'output_bits', 'ex_source_max', 'ex_operation_max', 'ex_source_sum', 'ex_operation_sum', 'nodes', 'initial_q', 'q_y', 'inputs', 'outputs', 'FIFOS', 'display'];

/** Fail closed: only a complete, verified V4 snapshot can be compiled/executed. */
export function compileModel(raw) {
  fields(raw, TOP_FIELDS, [], '快照');
  assert(raw.format === CONFIG.format, `format 必须为 ${CONFIG.format}；拒绝旧快照，不自动转换`);
  assert(typeof raw.name === 'string', 'name 必须为字符串');
  checkTime(raw.created_at);
  fields(raw.display, ['show'], [], 'display');
  assert(typeof raw.display.show === 'string', 'display.show 必须为字符串');
  for (const key of ['input_bits', 'output_bits']) assert(integer(raw[key]) && raw[key] <= CONFIG.ports.maximum, `${key} 必须为 0..216 的整数`);
  assert(Array.isArray(raw.nodes) && raw.nodes.length > 0, 'nodes 必须为非空数组');
  assert(integer(raw.jk_bits_max) && raw.nodes.length <= raw.jk_bits_max, '节点数超过 jk_bits_max 或容量非法');
  fields(raw.initial_q, ['0', '1'], [], 'initial_q');
  const initials = new Map();
  for (const value of [0, 1]) {
    const ids = raw.initial_q[value];
    assert(Array.isArray(ids), `initial_q[${value}] 必须为数组`);
    let previous = -1;
    for (const id of ids) {
      assert(typeof id === 'string' && /^Q(0|[1-9]\d*)$/.test(id), 'initial_q 包含非法 Q 编号');
      const index = Number(id.slice(1));
      assert(Number.isSafeInteger(index) && index < raw.nodes.length && id === 'Q' + index, `initial_q 引用不存在或编号非法：${id}`);
      assert(index > previous && !initials.has(id), `initial_q 必须排序且不重复或冲突：${id}`);
      previous = index; initials.set(id, value);
    }
  }
  const nodes = raw.nodes.map((data, i) => {
    fields(data, ['id', 'ex'], ['pro'], `nodes[${i}]`);
    assert(data.id === 'Q' + i, `nodes 必须按连续编号排序：期望 Q${i}`);
    const tokens = parseExpression(data.ex), initial = initials.get(data.id) ?? null;
    const pro = Object.hasOwn(data, 'pro') ? data.pro : CONFIG.propagation.default;
    assert(CONFIG.propagation.allowed.includes(pro), `${data.id} 的 pro 非法`);
    assert(initial !== null || pro !== 'q=', `${data.id} 无状态节点不得采用 q=`);
    assert(initial !== null || tokens[0].text === 'J0', `${data.id} 无状态节点必须以 J0 开头`);
    const sources = [...new Set(tokens.flatMap(t => t.source ? [t.source] : []))];
    assert(initial !== null || !sources.includes(data.id), `${data.id} 无状态节点不得自引用`);
    const eventSources = sources.filter(s => s !== data.id);
    assert(eventSources.length > 0, `${data.id} ex_source 必须 >= 1，拒绝纯常量或仅自引用节点`);
    const input = i < raw.input_bits ? 'X' + i : null;
    if (input) assert(initial !== null && data.ex === `J0K(${input})`, `${data.id} 必须为同编号有状态输入副本 J0K(${input})`);
    for (const source of sources) {
      if (source.startsWith('X')) assert(source === input, `${data.id} 只有同编号输入副本可以引用 Xi`);
      else assert(Number(source.slice(1)) < raw.nodes.length, `${data.id} 引用不存在：${source}`);
    }
    return { key: `node-${i}`, id: data.id, ex: data.ex, tokens, initial, pro, input, sources, eventSources, required: [], errors: [] };
  });
  assert(nodes.length >= raw.input_bits, '缺少同编号输入副本');
  const byId = new Map(nodes.map(n => [n.id, [n]])), targets = new Map();
  for (const n of nodes) {
    n.required = n.eventSources.filter(s => s.startsWith('Q') && byId.get(s)[0].initial === null).sort(order);
    for (const source of n.eventSources) {
      if (!targets.has(source)) targets.set(source, []);
      targets.get(source).push(n);
    }
  }
  for (const prefix of ['X', 'Y']) {
    const key = prefix === 'X' ? 'inputs' : 'outputs', size = prefix === 'X' ? raw.input_bits : raw.output_bits;
    assert(canonical(raw[key]) === canonical(identityPorts(prefix, size)), `${key} 必须为按编号排序的端口身份映射且数量与位宽相同`);
  }
  assert(Array.isArray(raw.q_y) && raw.q_y.length === raw.output_bits, 'q_y 数量与 output_bits 不一致');
  const outputs = raw.q_y.map((entry, i) => {
    const id = 'Y' + i;
    fields(entry, [id], [], `q_y[${i}]`);
    const source = entry[id];
    assert(typeof source === 'string' && byId.has(source), `${id} 必须绑定已有 Q`);
    assert(byId.get(source)[0].pro === CONFIG.propagation.default, `${id} 只能绑定 pro=q=0/1 的 Q`);
    return { id, source, error: null };
  });
  const outputCounts = new Map();
  for (const o of outputs) outputCounts.set(o.source, (outputCounts.get(o.source) ?? 0) + 1);
  for (const n of nodes) assert((targets.get(n.id)?.length ?? 0) + (outputCounts.get(n.id) ?? 0) >= 1, `${n.id} 的被引用数量必须 >= 1`);
  // Check ALL Q connections, irrespective of state/pro filters.
  const degrees = new Map(nodes.map(n => [n.id, n.eventSources.filter(s => s.startsWith('Q')).length]));
  const ready = nodes.filter(n => degrees.get(n.id) === 0);
  for (let i = 0; i < ready.length; i++) for (const n of targets.get(ready[i].id) ?? []) {
    degrees.set(n.id, degrees.get(n.id) - 1);
    if (degrees.get(n.id) === 0) ready.push(n);
  }
  assert(ready.length === nodes.length, 'Q 连接必须为 DAG；仅允许有状态自身引用，不允许多节点环');
  fields(raw.FIFOS, CONFIG.queues.map(q => q.name), [], 'FIFOS');
  for (const { name } of CONFIG.queues) {
    assert(Array.isArray(raw.FIFOS[name]), `${name} 必须为数组`);
    for (const task of raw.FIFOS[name]) {
      assert(object(task) && Object.keys(task).length === 1, `${name} 任务必须恰好包含一个目标 Q`);
      const [target, values] = Object.entries(task)[0], n = byId.get(target)?.[0];
      assert(n && Boolean(n.input) === (name === 'Xi.FIFO'), `${name} 任务目标不存在或队列归属错误：${target}`);
      fields(values, n.required, [], `${target} 任务锁存数据`);
      assert(Object.values(values).every(bit), `${target} 任务数据只能为 0/1`);
    }
  }
  for (const [key, value] of Object.entries(metrics(raw.nodes))) assert(raw[key] === value, `${key} 统计不符，应为 ${value}`);
  for (const [key, value] of Object.entries(fingerprints(raw))) assert(typeof raw[key] === 'string' && raw[key] === value, `${key} 指纹不符`);
  return { raw: structuredClone(raw), nodes, byId, valid: nodes, inputs: Array.from({ length: raw.input_bits }, (_, i) => 'X' + i), outputs, targets, issues: [] };
}

/** Package newly designed V4 structures; NOT a legacy snapshot loader. */
export function createSnapshot(options) {
  fields(options, ['nodes', 'initial_q', 'q_y', 'input_bits'], ['name', 'jk_bits_max', 'FIFOS', 'created_at', 'display'], '新模型构建参数');
  const { nodes, initial_q, q_y, input_bits } = structuredClone(options);
  for (const [i, n] of nodes.entries()) fields(n, ['id', 'ex'], ['pro'], `nodes[${i}]`);
  const stats = metrics(nodes);
  const raw = {
    name: options.name ?? 'JK V4 model', md5: '', format: CONFIG.format, format_md5: '',
    created_at: options.created_at ?? createdAt(), input_bits,
    jk_bits_max: options.jk_bits_max ?? nodes.length, jk_bits: nodes.length, output_bits: q_y.length,
    ex_source_max: stats.ex_source_max, ex_operation_max: stats.ex_operation_max,
    ex_source_sum: stats.ex_source_sum, ex_operation_sum: stats.ex_operation_sum,
    nodes: normalizedNodes(nodes), initial_q, q_y,
    inputs: identityPorts('X', input_bits), outputs: identityPorts('Y', q_y.length),
    FIFOS: structuredClone(options.FIFOS ?? emptyFifos()), display: structuredClone(options.display ?? CONFIG.display),
  };
  Object.assign(raw, fingerprints(raw));
  compileModel(raw);
  return raw;
}
