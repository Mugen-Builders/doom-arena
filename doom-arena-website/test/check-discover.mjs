// Compares a live node's `rpc.discover` document with the pinned fixture the
// unit tests run against, so node drift shows up as a diff instead of as a
// broken panel. Needs network; not part of `npm test`.
//
//   npm run check:discover -- <nodeUrl> [--update]
//
// <nodeUrl> is the node base URL (JSON-RPC at <nodeUrl>/rpc), default
// http://localhost:10011. --update overwrites the fixture with the live document.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const update = args.includes("--update");
const NODE_URL = args.find((a) => !a.startsWith("--")) ?? "http://localhost:10011";
const FIXTURE = new URL("./fixtures/jsonrpc-discover.json", import.meta.url);

const res = await fetch(`${NODE_URL}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover", params: [] }),
});
if (!res.ok) {
  console.error(`HTTP ${res.status} from ${NODE_URL}/rpc`);
  process.exit(2);
}
const env = await res.json();
if (env.error) {
  console.error(`rpc.discover failed: ${env.error.message} (${env.error.code})`);
  process.exit(2);
}
const live = env.result;
const pinned = JSON.parse(readFileSync(FIXTURE, "utf8"));

// Structural comparison only: descriptions and examples change freely.
const strip = (o) => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (["description", "summary", "example", "examples", "title", "x-batch-list-work-budget"].includes(k)) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return o;
};
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

let diffs = 0;
const report = (kind, name, detail = "") => {
  diffs++;
  console.log(`  ${kind.padEnd(8)} ${name}${detail ? "  " + detail : ""}`);
};

console.log(`node=${NODE_URL}  live version=${live.info?.version}  pinned version=${pinned.info?.version}\n`);

console.log("methods:");
const lm = Object.fromEntries(live.methods.map((m) => [m.name, m]));
const pm = Object.fromEntries(pinned.methods.map((m) => [m.name, m]));
for (const name of Object.keys(pm)) if (!lm[name]) report("removed", name);
for (const name of Object.keys(lm)) if (!pm[name]) report("added", name);
for (const name of Object.keys(pm)) {
  if (!lm[name]) continue;
  const pp = pm[name].params.map((p) => p.name).sort();
  const lp = lm[name].params.map((p) => p.name).sort();
  if (pp.join() !== lp.join()) report("params", name, `pinned [${pp}] live [${lp}]`);
  else if (!same(pm[name].params, lm[name].params)) report("params", name, "schema changed");
  if (!same(pm[name].result, lm[name].result)) report("result", name);
}

console.log("schemas:");
const ls = live.components?.schemas ?? {};
const ps = pinned.components?.schemas ?? {};
for (const name of Object.keys(ps)) if (!ls[name]) report("removed", name);
for (const name of Object.keys(ls)) if (!ps[name]) report("added", name);
for (const name of Object.keys(ps)) {
  if (!ls[name] || same(ps[name], ls[name])) continue;
  const pp = Object.keys(ps[name].properties ?? {});
  const lp = Object.keys(ls[name].properties ?? {});
  const gone = pp.filter((k) => !lp.includes(k));
  const added = lp.filter((k) => !pp.includes(k));
  const changed = pp.filter((k) => lp.includes(k) && !same(ps[name].properties[k], ls[name].properties[k]));
  const enumDiff = JSON.stringify(ps[name].enum) !== JSON.stringify(ls[name].enum);
  report(
    "changed",
    name,
    [
      gone.length ? `-${gone.join(",")}` : "",
      added.length ? `+${added.join(",")}` : "",
      changed.length ? `~${changed.join(",")}` : "",
      enumDiff ? `enum ${JSON.stringify(ps[name].enum)} -> ${JSON.stringify(ls[name].enum)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

console.log("errors:");
const le = live.components?.errors ?? {};
const pe = pinned.components?.errors ?? {};
for (const name of new Set([...Object.keys(pe), ...Object.keys(le)])) {
  if (!le[name]) report("removed", name);
  else if (!pe[name]) report("added", name, `code ${le[name].code}`);
  else if (pe[name].code !== le[name].code) report("code", name, `${pe[name].code} -> ${le[name].code}`);
}

if (diffs === 0) {
  console.log("\nlive rpc.discover matches the pinned fixture");
  process.exit(0);
}
console.log(`\n${diffs} difference(s)`);
if (update) {
  writeFileSync(FIXTURE, JSON.stringify(live, null, 2) + "\n");
  console.log(`fixture updated: ${FIXTURE.pathname} — now update test/fixtures/README and run npm test`);
  process.exit(0);
}
process.exit(1);
