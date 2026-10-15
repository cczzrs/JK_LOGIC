/** Atomic EX evaluation, immediate propagation and fixed-priority task queues. */
import { CONFIG, assert, object, compileModel, createSnapshot } from './model.mjs';
export { compileModel, parseExpression, order } from './model.mjs';

export class JKEngine {
  constructor(model, { historyLimit = CONFIG.runtime.historyLimit } = {}) {
    assert(model?.raw, 'JKEngine 需要 compileModel 返回的已校验模型');
    assert(Number.isSafeInteger(historyLimit) && historyLimit >= 0, 'historyLimit 必须为非负整数');
    this.model = compileModel(model.raw); this.historyLimit = historyLimit; this.reset();
  }
  reset() {
    this.fifos = new Map(CONFIG.queues.map(({ name }) => [name, { tasks: [], head: 0 }]));
    this.nextId = 1; this.total = 0; this.processed = 0;
    this.q = new Map(); this.x = new Map(); this.cache = new Map(); this.latest = new Map();
    this.counts = new Map(); this.last = new Map(); this.history = [];
    this.outputs = new Map(this.model.outputs.map(o => [o.id, null]));
    for (const n of this.model.nodes) {
      if (n.initial !== null) this.q.set(n.id, n.initial);
      this.cache.set(n.key, new Map()); this.counts.set(n.key, 0);
    }
    for (const { name } of CONFIG.queues) for (const task of this.model.raw.FIFOS[name]) {
      const [id, values] = Object.entries(task)[0];
      this.enqueue(this.model.byId.get(id)[0], values);
    }
  }
  queueLength(name) { const q = this.fifos.get(name); return q.tasks.length - q.head; }
  get length() { return CONFIG.queues.reduce((sum, q) => sum + this.queueLength(q.name), 0); }
  itemAt(i) {
    for (const { name } of CONFIG.queues) {
      const q = this.fifos.get(name), size = this.queueLength(name);
      if (i < size) return q.tasks[q.head + i];
      i -= size;
    }
    return undefined;
  }
  enqueue(node, values = {}) {
    const queue = node.input ? 'Xi.FIFO' : 'Qi.FIFO';
    const item = Object.freeze({ ticket: this.nextId++, node, values: Object.freeze({ ...values }), queue });
    this.fifos.get(queue).tasks.push(item);
    return item;
  }
  publish(source, value, transfers) {
    this.latest.set(source, value);
    for (const n of this.model.targets.get(source) ?? []) {
      let ready = false;
      if (n.required.length === 0) ready = true;
      else if (n.required.includes(source)) {
        const arrivals = this.cache.get(n.key);
        arrivals.set(source, value);
        ready = n.required.every(s => arrivals.has(s));
      }
      transfers.push({ source, target: n.id, value, ready });
      if (ready) {
        const arrivals = this.cache.get(n.key);
        this.enqueue(n, Object.fromEntries(arrivals)); arrivals.clear();
      }
    }
    for (const o of this.model.outputs) if (o.source === source) {
      this.outputs.set(o.id, value); transfers.push({ source, target: o.id, value, ready: false });
    }
  }
  remember(event) {
    if (this.historyLimit > 0) {
      this.history.push(event);
      if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    }
    return event;
  }
  send(data) {
    assert(object(data), '输入必须是 JSON 对象，例如 {"X0":1}');
    const keys = Object.keys(data);
    assert(keys.length > 0, 'send 必须至少提交一个 Xi');
    for (const id of keys) {
      assert(this.model.inputs.includes(id), `未知输入 ${id}`);
      assert(data[id] === 0 || data[id] === 1, `${id} 的值必须为数字 0 或 1；本次未发送任何输入`);
    }
    const accepted = this.model.inputs.filter(id => Object.hasOwn(data, id)), transfers = [];
    for (const id of accepted) {
      this.x.set(id, data[id]);
      const node = this.model.byId.get('Q' + id.slice(1))[0];
      this.enqueue(node); transfers.push({ source: id, target: node.id, value: data[id], ready: true });
    }
    return this.remember({ type: 'input', accepted, transfers });
  }
  step() {
    const chosen = CONFIG.queues.find(q => this.queueLength(q.name) > 0);
    if (!chosen) return null;
    const queue = this.fifos.get(chosen.name), item = queue.tasks[queue.head++], n = item.node;
    if (queue.head > 2048 && queue.head * 2 > queue.tasks.length) { queue.tasks = queue.tasks.slice(queue.head); queue.head = 0; }
    this.processed++;
    const before = n.initial === null ? null : this.q.get(n.id), reads = {};
    // Fix every distinct parameter before the first operation, including self q.
    for (const source of n.sources) {
      const x = source.startsWith('X') ? this.x.get(source) : this.q.has(source) ? this.q.get(source) : item.values[source];
      if (x !== 0 && x !== 1) return this.remember({ type: 'skipped', ticket: item.ticket, queue: chosen.name, node: n.id, before, reason: `参数不可读：${source}`, reads, operations: [], transfers: [] });
      reads[source] = x;
    }
    let value = before ?? 0;
    const operations = [];
    for (const t of n.tokens) {
      const x = t.source ? reads[t.source] : t.constant, previous = value;
      value = t.op === 'J' ? value & x : value ^ x;
      operations.push({ token: t.text, before: previous, input: x, after: value });
    }
    if (n.initial !== null) this.q.set(n.id, value);
    this.total++; this.counts.set(n.key, this.counts.get(n.key) + 1);
    const published = n.pro === 'q=0/1' || n.pro === `q=${value}`, transfers = [];
    if (published) this.publish(n.id, value, transfers);
    const event = { type: 'execution', ticket: item.ticket, queue: chosen.name, node: n.id, before, value, reads, operations, published, transfers, total: this.total };
    this.last.set(n.key, event);
    return this.remember(event);
  }
  waiting(n) { return n.required.filter(s => !this.cache.get(n.key).has(s)); }
  /** Synchronous calls occur between atomic tasks; capture q and FIFOS together. */
  snapshot({ name = this.model.raw.name, created_at } = {}) {
    const initial_q = { '0': [], '1': [] };
    for (const n of this.model.nodes) if (n.initial !== null) initial_q[this.q.get(n.id)].push(n.id);
    const FIFOS = Object.fromEntries(CONFIG.queues.map(({ name }) => {
      const q = this.fifos.get(name);
      return [name, q.tasks.slice(q.head).map(item => ({ [item.node.id]: { ...item.values } }))];
    }));
    return createSnapshot({ name, nodes: this.model.raw.nodes, initial_q, q_y: this.model.raw.q_y,
      input_bits: this.model.raw.input_bits, jk_bits_max: this.model.raw.jk_bits_max, FIFOS,
      display: this.model.raw.display, ...(created_at === undefined ? {} : { created_at }) });
  }
}
