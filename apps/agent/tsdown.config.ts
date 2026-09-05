import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  // Bundle the workspace package AND its own deps: cborg / @noble/* are NOT runtime deps of the
  // published `shellbell` tarball, so leaving them external produces a dist/cli.js that imports
  // packages nobody installs. `zod` stays external because it IS a declared runtime dep.
  noExternal: [/^@shellbell\//, "cborg", /^@noble\//],
  external: ["ws", "@bufbuild/protobuf", "commander", "qrcode-terminal", "zod"],
  // tsdown 0.23's default `fixedExtension: true` (for platform: "node") always emits `.mjs`
  // regardless of the package's `"type": "module"`; the package's bin field is `dist/cli.js`
  // (matching this repo's other packages), so force the extension tsdown would otherwise pick
  // for an ESM package with fixedExtension off.
  fixedExtension: false,
});
