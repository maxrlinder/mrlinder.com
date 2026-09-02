import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "index.html",
  "cv/index.html",
  "work/index.html",
  "notes/index.html",
  "lab/index.html",
  "about/index.html",
  "photos/index.html",
  "links/index.html",
  "contact/index.html",
  "RL-environment/index.html",
  "RL-environment/plump-logo.svg",
  "RL-environment/plump/index.html",
  "RL-environment/rl.css",
  "RL-environment/plump/game.js",
  "RL-environment/plump/multiplayer.js",
  "RL-environment/plump/model-config.js",
  "RL-environment/plump/model-client.js",
  "RL-environment/plump/tokens.js",
  "RL-environment/plump/model/plump-ppo-93200-ev-fp32.onnx",
  "RL-environment/plump/model/plump-ppo-93200-ev-fp32.json",
  "RL-environment/plump/model/plump-ppo-93200-ev-fp16.onnx",
  "RL-environment/plump/model/plump-ppo-93200-ev-fp16.json",
  "RL-environment/plump/model/plump-oracle-93200-ev-fp32.onnx",
  "RL-environment/plump/model/plump-oracle-93200-ev-fp32.json",
  "styles.css",
  "site-config.js",
  "site-navigation.js",
  "script.js",
  "resources/CV_Max_R_Linder.pdf",
  "resources/og-name-only.png",
  "resources/og-plump.png",
  "resources/about/web/portrait.jpg",
  "resources/about/web/sailing.jpg",
  "resources/about/web/military.jpg",
  "resources/about/web/kusten.jpg",
  "resources/about/web/sarek.jpg",
  "resources/about/web/bal.jpg",
  "resources/about/web/publicis.jpg",
  "resources/about/web/garment.png",
  "resources/about/web/ceremony.jpg",
  "resources/about/web/ski.jpg",
];

await Promise.all(required.map((file) => access(resolve(root, file))));

const pages = await Promise.all(
  [
    "index.html",
    "cv/index.html",
    "about/index.html",
    "RL-environment/index.html",
    "RL-environment/plump/index.html",
  ].map((file) =>
    readFile(resolve(root, file), "utf8"),
  ),
);

for (const [index, page] of pages.entries()) {
  if (!page.includes('name="viewport"')) {
    throw new Error(`Missing viewport metadata in page ${index + 1}`);
  }
  if (!page.includes("Skip to")) {
    throw new Error(`Missing skip link in page ${index + 1}`);
  }
  if (!page.includes("property=\"og:image\"") || !page.includes("/resources/")) {
    throw new Error(`Missing social preview metadata in page ${index + 1}`);
  }
}

console.log("Checked routes, assets, metadata, and accessibility hooks.");

// The Plump agent only plays well on the exact token stream it was trained on,
// and a mismatch is silent at runtime. Importing this runs the comparison.
await import("./check-plump-tokens.mjs");
