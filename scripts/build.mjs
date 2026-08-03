import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
const client = resolve(output, "client");
const server = resolve(output, "server");
const routes = [
  "cv",
  "work",
  "notes",
  "lab",
  "about",
  "photos",
  "links",
  "contact",
];

const files = [
  "index.html",
  "styles.css",
  "site-config.js",
  "site-navigation.js",
  "script.js",
  "CNAME",
];

await rm(output, { recursive: true, force: true });
await Promise.all(
  routes.map((route) => mkdir(resolve(client, route), { recursive: true })),
);
await mkdir(server, { recursive: true });

await Promise.all(
  files.map((file) => cp(resolve(root, file), resolve(client, file))),
);

await Promise.all(
  routes.map((route) =>
    cp(
      resolve(root, route, "index.html"),
      resolve(client, route, "index.html"),
    ),
  ),
);
await cp(resolve(root, "resources"), resolve(client, "resources"), {
  recursive: true,
});
await rm(resolve(client, "resources", "about"), {
  recursive: true,
  force: true,
});
await cp(
  resolve(root, "resources", "about", "web"),
  resolve(client, "resources", "about", "web"),
  { recursive: true },
);
await cp(resolve(root, "worker", "index.js"), resolve(server, "index.js"));

console.log("Built static site in dist/");
