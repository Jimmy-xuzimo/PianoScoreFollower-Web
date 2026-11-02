const fs = require("node:fs"),
  path = require("node:path");
const root = path.resolve(__dirname, ".."),
  vendor = path.join(root, "vendor");
fs.mkdirSync(vendor, { recursive: true });
const base = path.join(root, "node_modules/@tensorflow");
for (const [name, p] of [
  ["tf-core.min.js", "tfjs-core/dist/tf-core.min.js"],
  ["tf-backend-cpu.min.js", "tfjs-backend-cpu/dist/tf-backend-cpu.min.js"],
  ["tf-tflite.min.js", "tfjs-tflite/dist/tf-tflite.min.js"],
])
  fs.copyFileSync(path.join(base, p), path.join(vendor, name));
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (
      entry.name.startsWith("tflite_web_api_cc") &&
      /\.(js|wasm)$/.test(entry.name)
    )
      fs.copyFileSync(p, path.join(vendor, entry.name));
  }
}
walk(path.join(base, "tfjs-tflite"));
console.log("Vendored pinned TensorFlow runtime");
