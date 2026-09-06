import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../../packages/protocol/test/vectors.json");
const dest = resolve(here, "../src/util/vectors.json");
const wanted = readFileSync(src, "utf8");

if (process.argv.includes("--check")) {
  const have = readFileSync(dest, "utf8");
  if (have !== wanted) {
    console.error("src/util/vectors.json is stale; run: pnpm -F @shellbell/mobile sync:vectors");
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(dest, wanted);
