/** Deterministic JK interpreter. No rendering, clocks, or browser dependencies. */
const qPattern = 'Q(?:0|[1-9]\\d*)(?:L[1-9][RGB][0-7])?';
const qId = new RegExp(`^${qPattern}$`);
export const order = (a, b) => {
  const [, aIndex, aSuffix] = /^[XQY](\d+)(.*)$/.exec(a);
  const [, bIndex, bSuffix] = /^[XQY](\d+)(.*)$/.exec(b);
  const x = BigInt(aIndex), y = BigInt(bIndex);
  return x < y ? -1 : x > y ? 1 : aSuffix < bSuffix ? -1 : aSuffix > bSuffix ? 1 : 0;
};
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function parseExpression(ex) {
  if (typeof ex !== 'string') throw new Error('ex 必须是字符串');
  const source = ex.replace(/\s/g, '');
  if (!source) throw new Error('ex 不能为空');
  const tokens = [];
  const re = new RegExp(`([JK])(?:([01])|\\((X(?:0|[1-9]\\d*)|${qPattern})\\))`, 'y');
  let pos = 0;
  while (pos < source.length) {
    re.lastIndex = pos;
    const match = re.exec(source);
    if (!match) throw new Error(`ex 第 ${pos + 1} 个字符无法解析：${source.slice(pos, pos + 12)}`);
    tokens.push({ op: match[1], constant: match[2] === undefined ? null : Number(match[2]), source: match[3] ?? null, text: match[0], index: tokens.length });
    pos = re.lastIndex;
  }
  return tokens;
}
export function compileModel(raw) {
  if (!object(raw) || !Array.isArray(raw.nodes) || !object(raw.initial_q) || !Array.isArray(raw.q_y)) throw new Error('模型必须包含 nodes 数组、initial_q 对象、q_y 数组');
  if (!Array.isArray(raw.initial_q['0']) || !Array.isArray(raw.initial_q['1'])) throw new Error('initial_q 的 0、1 必须都是数组');
  const issues = [], byId = new Map(), inputs = new Set();
  const nodes = raw.nodes.map((data, i) => {
    const n = { key: `node-${i}`, id: String(data?.id ?? `无编号-${i}`), ex: data?.ex, errors: [], tokens: [], initial: null, sources: [], required: [] };
    if (!qId.test(n.id)) n.errors.push('JK 节点 ID 必须为 Q + 非负整数（无前导零），可选后缀为 L[1-9][RGB][0-7]');
    try { n.tokens = parseExpression(n.ex); } catch (e) { n.errors.push(e.message); }
    if (!byId.has(n.id)) byId.set(n.id, []);
    byId.get(n.id).push(n);
    return n;
  });
  for (const group of byId.values()) if (group.length > 1) group.forEach(n => n.errors.push('节点 ID 重复，所有同名节点均禁止执行'));
  const assigned = new Set();
  for (const bit of [0, 1]) for (const id of raw.initial_q[bit]) {
    const group = byId.get(id);
    if (!group) { issues.push(`initial_q 引用不存在的节点：${String(id)}`); continue; }
    if (assigned.has(id)) group.forEach(n => n.errors.push('initial_q 重复赋值或 0/1 冲突'));
    assigned.add(id); group.forEach(n => { n.initial = bit; });
  }
  for (const n of nodes) {
    n.sources = [...new Set(n.tokens.flatMap(t => t.source ? [t.source] : []))];
    if (n.initial === null && n.tokens[0]?.text !== 'J0') n.errors.push('无状态 JK 节点必须以 J0 开头');
    for (const s of n.sources) {
      if (s.startsWith('X')) inputs.add(s);
      else if (!byId.has(s)) n.errors.push(`引用不存在：${s}`);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) if (!n.errors.length) {
      const bad = n.sources.find(s => s.startsWith('Q') && byId.get(s)?.some(x => x.errors.length));
      if (bad) { n.errors.push(`依赖异常：${bad}`); changed = true; }
    }
  }
  for (const n of nodes) n.required = n.sources.filter(s => s.startsWith('X') || byId.get(s)?.[0].initial === null);
  const outputMap = new Map();
  for (const entry of raw.q_y) {
    if (!object(entry) || Object.keys(entry).length !== 1) { issues.push('q_y 每项必须为一个 {Yi: Qj} 映射'); continue; }
    const [id, source] = Object.entries(entry)[0];
    if (!/^Y(0|[1-9]\d*)$/.test(id)) { issues.push(`无效输出 ID：${id}`); continue; }
    const error = typeof source !== 'string' || !qId.test(source) || !byId.has(source) ? '输出引用不存在或格式错误' : byId.get(source).some(n => n.errors.length) ? '输出依赖异常' : null;
    if (outputMap.has(id)) { outputMap.get(id).error = '输出 ID 重复'; issues.push(`输出 ID 重复：${id}`); }
    else outputMap.set(id, { id, source, error });
  }
  const outputs = [...outputMap.values()].sort((a,b) => order(a.id,b.id));
  const valid = nodes.filter(n => !n.errors.length);
  const targets = new Map();
  for (const n of valid) for (const s of n.sources) {
    if (!targets.has(s)) targets.set(s, []);
    targets.get(s).push(n);
  }
  for (const list of targets.values()) list.sort((a,b) => order(a.id,b.id));
  return { raw, nodes, byId, valid, inputs: [...inputs].sort(order), outputs, targets, issues };
}
export class JKEngine {
  constructor(model, { queueLimit = 10000, historyLimit = 400 } = {}) {
    this.model = model; this.queueLimit = queueLimit; this.historyLimit = historyLimit; this.reset();
  }
  reset() {
    this.queue = []; this.head = 0; this.nextId = 1; this.total = 0;
    this.q = new Map(); this.cache = new Map(); this.latest = new Map(); this.counts = new Map(); this.last = new Map(); this.history = [];
    this.outputs = new Map(this.model.outputs.map(o => [o.id, null]));
    for (const n of this.model.nodes) {
      if (n.initial !== null && !n.errors.length) this.q.set(n.id, n.initial);
      this.cache.set(n.key, new Map()); this.counts.set(n.key, 0);
    }
    for (const n of [...this.model.valid].sort((a,b) => order(a.id,b.id))) if (!n.sources.length) this.enqueue(n);
  }
  get length() { return this.queue.length - this.head; }
  get capacityReached() { return this.length >= this.queueLimit; }
  itemAt(i) { return this.queue[this.head + i]; }
  enqueue(n) {
    const values = Object.freeze(Object.fromEntries(this.cache.get(n.key)));
    this.queue.push(Object.freeze({ ticket: this.nextId++, node: n, values }));
    this.cache.get(n.key).clear();
  }
  publish(source, value, transfers) {
    this.latest.set(source, value);
    for (const n of this.model.targets.get(source) ?? []) {
      if (n.required.includes(source)) this.cache.get(n.key).set(source, value);
      const ready = n.required.every(s => this.cache.get(n.key).has(s));
      transfers.push({ source, target: n.id, value, ready });
      if (ready) this.enqueue(n);
    }
    for (const o of this.model.outputs) if (!o.error && o.source === source) {
      this.outputs.set(o.id, value); transfers.push({ source, target: o.id, value, ready: false });
    }
  }
  remember(event) {
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    return event;
  }
  send(data) {
    if (!object(data)) throw new Error('输入必须是 JSON 对象，例如 {"X0":1}');
    const accepted = this.model.inputs.filter(id => Object.hasOwn(data, id));
    for (const id of accepted) if (typeof data[id] !== 'number' || (data[id] !== 0 && data[id] !== 1)) throw new Error(`${id} 的值必须为数字 0 或 1；本次未发送任何输入`);
    if (this.capacityReached) throw new Error('执行队列达到保护阈值，请先单步消费队列或重载');
    const transfers = [];
    for (const id of accepted) this.publish(id, data[id], transfers);
    return this.remember({ type: 'input', accepted, ignored: Object.keys(data).filter(id => !this.model.inputs.includes(id)), transfers });
  }
  step() {
    if (!this.length) return null;
    const item = this.queue[this.head++], n = item.node;
    if (this.head > 2048 && this.head * 2 > this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
    const before = n.initial === null ? null : this.q.get(n.id);
    let value = before ?? 0;
    const reads = {}, operations = [];
    for (const t of n.tokens) {
      const x = t.source ? (this.q.has(t.source) ? this.q.get(t.source) : item.values[t.source]) : t.constant;
      if (x !== 0 && x !== 1) throw new Error(`内部参数错误：${n.id} ← ${t.source}`);
      if (t.source) reads[t.source] = x;
      const previous = value;
      value = t.op === 'J' ? value & x : value ^ x;
      operations.push({ token: t.text, before: previous, input: x, after: value });
    }
    if (n.initial !== null) this.q.set(n.id, value);
    this.total++; this.counts.set(n.key, this.counts.get(n.key) + 1);
    const transfers = []; this.publish(n.id, value, transfers);
    const event = { type: 'execution', ticket: item.ticket, node: n.id, before, value, reads, operations, transfers, total: this.total };
    this.last.set(n.key, event);
    return this.remember(event);
  }
  waiting(n) { return n.required.filter(s => !this.cache.get(n.key).has(s)); }
}
