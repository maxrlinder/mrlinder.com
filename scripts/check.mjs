import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "index.html",
  "cv/index.html",
  "work/index.html",
  "notes/index.html",
  "lab/index.html",
  "photos/index.html",
  "links/index.html",
  "contact/index.html",
  "styles.css",
  "site-config.js",
  "site-navigation.js",
  "script.js",
  "resources/me_cutout.png",
  "resources/Max_R_Linder_CV.pdf",
];

await Promise.all(required.map((file) => access(resolve(root, file))));

const pages = await Promise.all(
  ["index.html", "cv/index.html"].map((file) =>
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
  if (!page.includes("/resources/og.png")) {
    throw new Error(`Missing social preview metadata in page ${index + 1}`);
  }
}

console.log("Checked routes, assets, metadata, and accessibility hooks.");
