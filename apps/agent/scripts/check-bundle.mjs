#!/usr/bin/env node
// Publish gate for `shellbell`. Fails loudly rather than shipping a tarball that cannot install.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const bundle = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");
const fail = (msg) => {
  console.error(`check-bundle: ${msg}`);
  process.exitCode = 1;
};

if (!bundle.startsWith("#!/usr/bin/env node")) fail("dist/cli.js is missing the shebang (spec 16)");

// 1. Nothing may still import a workspace package: those are bundled, never published.
if (/["']@shellbell\/[^"']+["']/.test(bundle)) {
  fail("dist/cli.js still references @shellbell/* — it must be bundled (tsdown alwaysBundle)");
}

// 2. Every bare import left in the bundle must be a declared runtime dependency.
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const specifiers = new Set();
for (const m of bundle.matchAll(/\bfrom\s*["']([^"'.][^"']*)["']/g)) specifiers.add(m[1]);
for (const m of bundle.matchAll(/\brequire\(\s*["']([^"'.][^"']*)["']\s*\)/g)) specifiers.add(m[1]);
for (const spec of specifiers) {
  if (spec.startsWith("node:")) continue;
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (!deps.has(name)) fail(`dist/cli.js imports "${spec}" which is not in dependencies`);
}

// 3. No workspace protocol may reach the tarball's manifest.
for (const [k, v] of Object.entries(pkg.dependencies ?? {})) {
  if (String(v).startsWith("workspace:"))
    fail(`dependency ${k} is "${v}" — move it to devDependencies`);
}

// 4. Nothing that looks like a credential may be in the bundle.
for (const marker of [
  "BEGIN PRIVATE KEY",
  "BEGIN RSA",
  "EXPO_ACCESS_TOKEN",
  "npm_",
  "ExponentPushToken[",
]) {
  if (bundle.includes(marker)) fail(`dist/cli.js contains the marker ${JSON.stringify(marker)}`);
}

if (process.exitCode) process.exit(1);
console.log("check-bundle: ok");
