# mrlinder.com

Personal website, served at https://mrlinder.com by GitHub Pages.

## Layout

```
site/                 Everything that is published, as is. A file's path under
                      site/ is its URL: site/cv/index.html is mrlinder.com/cv/.
  RL-environment/     The card games (Plump, Rummy, Piquet) and their agents
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
