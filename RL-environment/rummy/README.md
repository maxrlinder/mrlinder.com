# Rummy playground

Static browser game at `/RL-environment/rummy/`, deployed with the rest of
`mrlinder.com` through GitHub Pages. No inference server or API key is needed.
The ONNX actor runs in a module worker with ONNX Runtime Web 1.27.0 (WASM,
single thread, so cross-origin isolation is not required). The runtime downloads
from jsDelivr; checkpoint weights are served by this site and checked by SHA-256.

The UI supports 2–4 players, 13-card hands, focused or sampled policy play,
sets, cyclic runs, multi-meld 30-point openings, lay-offs, round scores, table
totals, adjustable pace, and auto-play. New tables clear table totals; another
round retains them. Refreshing the page clears the current game.

## Updating the checkpoint

Use a Python environment with `torch`, `numpy`, `onnx`, and `onnxruntime`.
The sibling `card_playing_gym` checkout is imported read-only; its training
process and environment do not need to be changed.

```sh
python scripts/export-rummy-model.py
# Or pin an exact checkpoint:
python scripts/export-rummy-model.py --checkpoint ../card_playing_gym/runs/rummy/r6/checkpoints/iter_023800.pt
npm run check
npm run build
```

Without `--checkpoint`, the exporter resolves the most recently written
`runs/rummy/*/checkpoints/latest.json` once. It writes a versioned FP32 actor,
then verifies it against native PyTorch on real decision sequences before
updating `model/manifest.json`. It also regenerates `rules-data.js` and the
Python game fixtures. Check the generated manifest for provenance, source and
artifact hashes, and numerical validation results. Remove the previous ONNX
file only after verifying its replacement; commit the new file and manifest
together. The browser reads the manifest without caching and caches immutable
versioned weights normally.

`node scripts/check-rummy.mjs` replays Python traces through the JS engine and
compares every token, ordered legal action, candidate feature, and final score.
It checks card conservation and all 589 melds and extensions. This check is also
part of `npm run check`. If the training representation or rules change, update
the browser engine and manifest schema instead of just swapping the weights.

The actor sees exactly one observer-relative token per own decision and only
its private hand plus public information. Histories are retained separately for
each seat. UI rendering never advances the observation writer. A model failure
pauses the game and allows retry; it does not substitute a different policy.
