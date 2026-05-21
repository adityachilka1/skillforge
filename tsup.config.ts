import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: true,
    dts: true,
    shims: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: false,
    dts: false,
    shims: false,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
