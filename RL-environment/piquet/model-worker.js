// Keep model compilation and inference off the UI thread.
let ort, session, manifest;
const runtime = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
const WIDTH = 63;
const tensor = (rows, shape) => new ort.Tensor('int64', BigInt64Array.from(rows.flat(), BigInt), shape);

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
  if (manifest.schemaVersion !== 1 || manifest.tokenWidth !== WIDTH || manifest.rules.mode !== 'deal') throw new Error('This checkpoint needs a newer game version. Please refresh.');
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
    const { id, type, tokens, following } = data;
    try {
      if (type === 'load') { postMessage({ id, result: await load(id) }); return; }
      if (!session) throw new Error('The agent is not loaded.');
      // One-token continuations of the stream, valued one move ahead; a plain
      // move still sends one (its own last token) and ignores the result.
      const rows = following?.length ? following : [tokens.at(-1)];
      const feeds = { tokens: tensor(tokens, [1, tokens.length, WIDTH]), following: tensor(rows, [rows.length, WIDTH]) };
      let outputs;
      try {
        outputs = await session.run(feeds);
        const read = name => Array.from(outputs[name].data);
        const flat = read('following_values');
        const result = {
          exchange: read('exchange_logits'), declare: read('declare_logits'), play: read('play_logits'),
          value: read('value'), belief: read('belief_logits'),
          after: following?.length ? following.map((_, i) => flat.slice(2 * i, 2 * i + 2)) : [],
        };
        if (![...result.exchange, ...result.declare, ...result.play, ...result.value, ...flat].every(Number.isFinite)) throw new Error('The agent returned an invalid move.');
        postMessage({ id, result });
      } finally {
        Object.values(feeds).forEach(t => t.dispose());
        if (outputs) Object.values(outputs).forEach(t => t.dispose());
      }
    } catch (error) { postMessage({ id, error: error.message || String(error) }); }
  });
};
