export class RummyAgent {
  constructor() { this.next = 0; this.pending = new Map(); }
  request(type, payload = {}, progress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
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
  // The policy itself (temperature 1) over the candidates, for the action-probability readout.
  async policy(tokens, features) {
    const { logits } = await this.request('choose', { tokens, features });
    if (logits.length !== features.kind.length) throw new Error('The agent returned the wrong number of moves.');
    const max = Math.max(...logits), weights = logits.map(v => Math.exp(v - max)), total = weights.reduce((a, b) => a + b, 0);
    return { probabilities: weights.map(w => w / total), argmax: logits.indexOf(max) };
  }
  async choose(tokens, features, temperature = 0) {
    const { logits } = await this.request('choose', { tokens, features });
    if (logits.length !== features.kind.length) throw new Error('The agent returned the wrong number of moves.');
    if (!temperature) return logits.indexOf(Math.max(...logits));
    if (!Number.isFinite(temperature)) return Math.floor(Math.random() * logits.length);
    const max = Math.max(...logits), weights = logits.map(v => Math.exp((v - max) / temperature));
    let draw = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) { draw -= weights[i]; if (draw <= 0) return i; }
    return weights.length - 1;
  }
}
