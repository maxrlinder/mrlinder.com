# mrlinder.com

Personal website, served at https://mrlinder.com by GitHub Pages.

## Layout

```
site/                 Everything that is published, as is. A file's path under
                      site/ is its URL: site/cv/index.html is mrlinder.com/cv/.
  RL-environment/     The card games (Plump, Rummy, Piquet, Hjärter) and their agents
  resources/          Images, fonts, card art and the CV PDF
scripts/              Local tooling, never published: dev server, checks, model
                      and training-chart exporters, SVG generators
  fixtures/           Python traces the checks replay through the JS engines
.github/workflows/    deploy.yml publishes site/ on every push to main
```

Full-size originals of the About photos can sit in `site/resources/about/`;
only `site/resources/about/web/` is committed.

## Working on it

```sh
npm run dev     # serve site/ at http://127.0.0.1:4173
npm run check   # routes, assets, metadata, and JS-vs-Python agent parity
```

Pushing to `main` deploys. Exporting a new game agent from the sibling
`card_playing_gym` checkout is described in
`site/RL-environment/rummy/README.md` and `site/RL-environment/piquet/README.md`.

## Large files: replace, don't add

The games' ONNX agents (17-40 MB each) are most of this repository, which
was 3.3 GB on GitHub in November 2026; GitHub recommends staying under 5 GB.
Git keeps every version ever committed, so a new checkpoint must replace the
old one rather than add to the history:

* Delete the superseded model file in the same commit that adds its
  replacement. Never keep old checkpoints under `site/`.
* A commit that only swaps a model can be replaced instead of followed:
  when `main`'s tip is such a commit, make the new one on the same parent
  and push it with `--force-with-lease`, so history keeps one version
  instead of every one. Never rewrite a commit that changes anything else.
* `scripts/hjarter-autopublish.py` does this for the Hjärter run in
  training, every ~2 hours (its commits carry an `Auto-published-by`
  trailer; see `site/RL-environment/hjarter/README.md`). So `main`'s tip
  may be rewritten under you: update with `git pull --rebase`, because a
  merge would bring the replaced model back into history.
