const { build } = require("esbuild");

const sharedConfig = {
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  // drop: [],
  // only needed if you have dependencies
  // external: Object.keys(dependencies).concat(Object.keys(peerDependencies)),
};

build({
  ...sharedConfig,
  platform: "browser",
  format: "esm",
  outfile: "dist/main.js",
});
