import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  minify: false,
  // Zero runtime dependencies: bundle anything that ends up imported.
  noExternal: [/.*/],
});
