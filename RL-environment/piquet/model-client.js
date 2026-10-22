import { STOP, NUM_CARDS } from './engine.js';

// Each head's logits index its actions: a card id (exchange adds STOP), or QUIET / SPEAK.
const HEAD_OUTPUT = { exchange: 'exchange', declare: 'declare', play: 'play' };
const softmax = values => {
  const max = Math.max(...values), weights = values.map(v => Math.exp(v - max)), total = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => w / total);
};

export class PiquetAgent {
  constructor() { this.next = 0; this.pending = new Map(); }
  request(type, payload = {}, progress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./model-worker.js?v=1', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const request = this.pending.get(data.id);
        if (!request) return;
        if (data.progress) { request.progress?.(data.progress); return; }
        clearTimeout(request.timer); this.pending.delete(data.id);
        if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
      };
      this.worker.onerror = () => this.reset(new Error('The agent could not start. Check your connection and try again.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => this.reset(new Error('The agent took too long to respond. Please retry.')), 180000);
      this.pending.set(id, { resolve, reject, progress, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  reset(error) {
    this.worker?.terminate(); this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }
  async load(progress) { const { manifest } = await this.request('load', {}, progress); this.manifest = manifest; return manifest; }

  // The policy (temperature 1) over `legal` actions of `head`, with the value
  // head now and after each `following` token (one move ahead), and the belief
  // head: for every card, where the seat thinks it is (opponent's hand, its
  // discards, the talon).
  async policy(tokens, head, legal, following = []) {
    const out = await this.request('choose', { tokens, following });
    const logits = out[HEAD_OUTPUT[head]];
    const probabilities = softmax(legal.map(action => logits[action]));
    const argmax = probabilities.indexOf(Math.max(...probabilities));
    const belief = Array.from({ length: NUM_CARDS }, (_, c) => softmax(out.belief.slice(3 * c, 3 * c + 3)));
    return { probabilities, argmax, value: out.value, after: out.after, belief };
  }

  // An action from `legal` at `temperature` (0: argmax, Infinity: uniform).
  async choose(tokens, head, legal, temperature = 0) {
    if (!Number.isFinite(temperature)) return legal[Math.floor(Math.random() * legal.length)];
    const out = await this.request('choose', { tokens });
    const logits = legal.map(action => out[HEAD_OUTPUT[head]][action]);
    if (!temperature) return legal[logits.indexOf(Math.max(...logits))];
    const max = Math.max(...logits), weights = logits.map(v => Math.exp((v - max) / temperature));
    let draw = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) { draw -= weights[i]; if (draw <= 0) return legal[i]; }
    return legal.at(-1);
  }
}

export { STOP };
