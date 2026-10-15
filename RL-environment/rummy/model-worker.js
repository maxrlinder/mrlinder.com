// Keep model compilation and inference off the UI thread.
let ort, session, manifest;
const runtime = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
const tensor = (data, shape) => new ort.Tensor('int64', BigInt64Array.from(data.flat(Infinity), BigInt), shape);

async function load(id) {
  if (session) return { manifest };
  const progress = (percent, message) => postMessage({ id, progress: { percent, message } });
  progress(2, 'Preparing the agent…');
  ort = await import(`${runtime}ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = runtime;
  ort.env.wasm.numThreads = 1;
  const response = await fetch(new URL('./model/manifest.json', import.meta.url), { cache: 'no-cache' });
  if (!response.ok) throw new Error('The agent manifest could not be loaded.');
  manifest = await response.json();
  if (manifest.schemaVersion !== 2 || manifest.tokenWidth !== 78 || manifest.rules.handSize !== 7 || manifest.rules.openingPoints !== 0 || manifest.rules.maxTurns !== 200) throw new Error('This checkpoint needs a newer game version. Please refresh.');
  const download = await fetch(new URL(`./model/${manifest.file}`, import.meta.url));
  if (!download.ok || !download.body) throw new Error('The checkpoint download failed. Please retry.');
  const reader = download.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
    progress(5 + Math.round(75 * size / manifest.bytes), `Downloading agent · ${Math.round(100 * size / manifest.bytes)}%`);
  }
  if (size !== manifest.bytes) throw new Error('The checkpoint download was incomplete. Please retry.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.sha256) throw new Error('The checkpoint did not pass its integrity check. Please retry.');
  progress(85, 'Getting the agent ready…');
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  progress(100, 'Agent ready');
  return { manifest };
}

let queue = Promise.resolve();
onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { id, type, tokens, features } = data;
    try {
      if (type === 'load') { postMessage({ id, result: await load(id) }); return; }
      if (!session) throw new Error('The agent is not loaded.');
      const count = features.kind.length;
      // Play decisions take nothing from the pile: all-zero pickup counts add nothing.
      const taken = features.taken ?? Array.from({ length: count }, () => Array(52).fill(0));
      const feeds = {
        tokens: tensor(tokens, [1, tokens.length, 78]),
        kind: tensor(features.kind, [1, count]),
        cards: tensor(features.cards, [1, count, 13]),
        target: tensor(features.target, [1, count, 13]),
        taken: tensor(taken, [1, count, 52]),
      };
      let outputs;
      try {
        outputs = await session.run(feeds);
        const logits = Array.from(outputs.logits.data);
        if (!logits.every(Number.isFinite)) throw new Error('The agent returned an invalid move.');
        postMessage({ id, result: { logits } });
      } finally {
        Object.values(feeds).forEach(t => t.dispose());
        if (outputs) Object.values(outputs).forEach(t => t.dispose());
      }
    } catch (error) { postMessage({ id, error: error.message || String(error) }); }
  });
};
