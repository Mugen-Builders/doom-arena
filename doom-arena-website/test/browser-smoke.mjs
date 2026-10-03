// Renders the site in headless Chrome against a fake rollups-node that answers
// with PR #798-shaped payloads (and a fake L1), then checks the DOM text. This
// is the only automated exercise main.js gets, so it targets what unit tests
// cannot: element ids, render paths, the startup gate, the mismatch guard.
//
// The page is bundled here with a test config (127.0.0.1:28080/28545, anvil chain)
// so the run does not depend on config.js or on what else listens locally.
//
//   node test/browser-smoke.mjs [scenario]
//
// Needs a Chrome binary: CHROME=/path/to/chrome, or a Playwright
// chromium/chrome-headless-shell under ~/.cache/ms-playwright.
import http from "node:http";
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { encodeAbiParameters, parseAbiParameters, getAddress, toFunctionSelector } from "viem";

import { OUTPUT_SELECTOR } from "../src/nodeRpc.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// Literal 127.0.0.1 throughout: Chrome tries ::1 first for "localhost" and, in
// some sandboxes, waits seconds per connection before falling back.
const SITE_HOST = "127.0.0.1";
const SITE_PORT = Number(process.env.SITE_PORT ?? 3000);
const SITE_ORIGIN = `http://${SITE_HOST}:${SITE_PORT}`; // what the node would have to allowlist
const RENDER_MS = Number(process.env.RENDER_MS ?? 10000);

// Test configuration baked into the smoke bundle in place of src/config.js.
// Ports are overridable so the smoke can run beside a real devnet.
const NODE_PORT = Number(process.env.SMOKE_NODE_PORT ?? 28080);
const L1_PORT = Number(process.env.SMOKE_L1_PORT ?? 28545);
const CFG = {
  EMULATOR_URL: "http://localhost:1/emulator", // unreachable on purpose
  CARTRIDGES_URL: "",
  CHAIN_ID: "0x7A69",
  APPLICATION_ADDRESS: "0xAD99e7c1c9bb884c7fa97d15E7fEDCeA04586abe",
  NODE_URL: `http://127.0.0.1:${NODE_PORT}`,
  INPUT_BOX_ADDRESS: "0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac",
  APPLICATION_NAME: "doom_arena",
  L1_RPC_URL: `http://127.0.0.1:${L1_PORT}`,
};
const nodeUrl = new URL(CFG.NODE_URL);
const L1_URL = new URL(CFG.L1_RPC_URL);
const CHAIN_ID = parseInt(CFG.CHAIN_ID, 16);
const L1_BLOCK = 1000;

// Bundle src/main.js with the test config swapped in for ./config.
async function buildSite() {
  const dir = mkdtempSync(join(tmpdir(), "doom-arena-smoke-"));
  const configSource = Object.entries(CFG)
    .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
    .join("\n");
  await build({
    entryPoints: [join(SRC, "main.js")],
    bundle: true,
    minify: false,
    platform: "browser",
    format: "esm",
    outfile: join(dir, "main.js"),
    plugins: [
      {
        name: "test-config",
        setup(b) {
          b.onResolve({ filter: /^\.\/config(\.js)?$/ }, () => ({ path: "test-config", namespace: "cfg" }));
          b.onLoad({ filter: /.*/, namespace: "cfg" }, () => ({ contents: configSource, loader: "js" }));
        },
      },
    ],
  });
  copyFileSync(join(SRC, "index.html"), join(dir, "index.html"));
  copyFileSync(join(SRC, "arena.css"), join(dir, "arena.css"));
  return dir;
}

// -------------------------------------------------------------
// fixtures (wire shapes, snake_case, hex quantities)
// -------------------------------------------------------------
const hex = (n) => "0x" + BigInt(n).toString(16);
const H = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const NOW = new Date().toISOString();
const APP = getAddress(CFG.APPLICATION_ADDRESS);
const IBOX = getAddress(CFG.INPUT_BOX_ADDRESS);
const CONSENSUS = "0x" + "da".repeat(20);
const T_ROOT = "0x" + "aa".repeat(20);
const T_INNER = "0x" + "bb".repeat(20);
const PLAYER = (i) => getAddress("0x" + (i + 1).toString(16).padStart(40, "0"));

const application = (over = {}) => ({
  name: "doom_arena",
  iapplication_address: APP,
  iconsensus_address: CONSENSUS,
  iinputbox_address: IBOX,
  template_hash: H(1),
  epoch_length: hex(10),
  claim_staging_period: hex(100),
  consensus_type: "PRT",
  enabled: true,
  status: "OK",
  reason: null,
  processed_inputs: hex(3),
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const epoch = (index, status, over = {}) => ({
  index: hex(index),
  first_block: hex(index * 10),
  last_block: hex(index * 10 + 9),
  input_index_lower_bound: hex(index),
  input_index_upper_bound: hex(index + 2),
  machine_hash: H(7),
  commitment: null,
  claim_transaction_hash: null,
  tournament_address: status === "OPEN" ? null : T_ROOT,
  status,
  staged_at_block: null,
  virtual_index: hex(index),
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

const noticePayload = (i) =>
  encodeAbiParameters(
    parseAbiParameters("address user, uint256 timestamp, int256 score, uint256 input_index"),
    [PLAYER(i), BigInt(1_700_000_000 + i), BigInt(1000 * (i + 1)), BigInt(i)],
  );
const output = (i) => ({
  epoch_index: hex(0),
  input_index: hex(i),
  index: hex(i),
  raw_data: OUTPUT_SELECTOR.Notice,
  decoded_data: { type: OUTPUT_SELECTOR.Notice, payload: noticePayload(i) },
  hash: H(100 + i),
  output_hashes_siblings: i % 2 ? [H(1), H(2)] : null,
  execution_transaction_hash: null,
  created_at: NOW,
  updated_at: NOW,
});

// The replayed tape: what cartesi_getInput hands the replay, byte for byte.
const REPLAY_TAPE = [1, 2, 3, 4, 5, 6, 7, 8];
const input = (i) => ({
  index: hex(i),
  epoch_index: hex(0),
  block_number: hex(100 + i),
  raw_data: "0x",
  decoded_data: {
    chain_id: hex(CHAIN_ID),
    application_contract: APP,
    sender: PLAYER(i),
    block_number: hex(100 + i),
    block_timestamp: hex(1_700_000_000 + i),
    prev_randao: "0x1",
    index: hex(i),
    // outhash (32 bytes) + tape
    payload: "0x" + "ab".repeat(32) + REPLAY_TAPE.map((b) => b.toString(16).padStart(2, "0")).join(""),
  },
  status: "ACCEPTED",
  transaction_hash: H(200 + i),
  log_index: hex(0),
  created_at: NOW,
  updated_at: NOW,
});

const tournament = (address, level, parent, standing) => ({
  epoch_index: hex(1),
  address,
  parent_tournament_address: parent,
  parent_match_id_hash: parent ? H(50) : null,
  max_level: hex(3),
  level: hex(level),
  log2step: hex(44),
  height: hex(48),
  kind: level === 2 ? "LEAF" : "NON_LEAF",
  initial_hash: H(7),
  base_cycle: "0x0",
  start_instant: hex(10),
  allowance: hex(200),
  creation_event: parent ? { block_number: hex(12), tx_hash: H(60), log_index: hex(0) } : null,
  snapshot: {
    as_of_block: hex(990),
    standing,
    accepts_joins: false,
    candidate: null,
    winner_commitment: null,
    final_state_hash: null,
    parent_commitment: null,
    finished_at_block: hex(0),
    winner_expires_at: hex(0),
    inner_result: null,
    bond_recovery: { disposition: "TOURNAMENT_RUNNING", claimer: null, payment: null },
  },
  created_at: NOW,
  updated_at: NOW,
});

const commitment = (tournament_address, c, running, deadline) => ({
  epoch_index: hex(1),
  tournament_address,
  commitment: c,
  final_state_hash: H(9),
  submitter_address: PLAYER(9),
  block_number: hex(11),
  tx_hash: H(70),
  log_index: hex(0),
  snapshot: {
    as_of_block: hex(990),
    claimer: PLAYER(9),
    clock_running: running,
    clock_deadline: hex(deadline),
    clock_allowance: hex(100),
  },
  created_at: NOW,
  updated_at: NOW,
});

const match = (tournament_address, id, one, two) => ({
  epoch_index: hex(1),
  tournament_address,
  id_hash: id,
  commitment_one: one,
  commitment_two: two,
  left_of_two: H(3),
  block_number: hex(12),
  tx_hash: H(71),
  log_index: hex(1),
  winner_commitment: "NONE",
  deletion_reason: "NOT_DELETED",
  deletion_block_number: null,
  deletion_tx_hash: null,
  deletion_log_index: null,
  eliminable_at: hex(0),
  leaf_seal: null,
  snapshot: {
    as_of_block: hex(990),
    phase: "BISECTING",
    bisection: {
      revealing_parent: H(4),
      waiting_left: H(5),
      waiting_right: H(6),
      segment_start_position: "0x0",
      segment_start_cycle: "0x0",
      current_height: hex(41),
      responder: "TWO",
    },
    sealed: null,
    timeout_outcome: "NONE",
    deferred_charge: hex(0),
  },
  created_at: NOW,
  updated_at: NOW,
});

const page = (rows, total = rows.length) => ({
  data: rows,
  pagination: { total_count: total, limit: rows.length, offset: 0 },
});

// eth_call answers, keyed by selector (the fake L1 ignores `to`).
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const l1Sealed = (epochIdx, tournament, staged = false, stagingBlock = 0, lo = 0, hi = 2) => [
  toFunctionSelector("getCurrentSealedEpoch()"),
  enc("uint256,uint256,uint256,address,bool,uint256,bytes32,bytes32", [
    BigInt(epochIdx), BigInt(lo), BigInt(hi), getAddress(tournament), staged, BigInt(stagingBlock), H(0), H(0),
  ]),
];
const l1CanStage = (finished, failed) => [
  toFunctionSelector("canStageTournamentResult()"),
  enc("bool,bool,bool,uint256,bytes32,bytes32", [finished, failed, false, 0n, H(0), H(0)]),
];
// TournamentStanding enum index: 0 MATCHES_ACTIVE, 1 AWAITING_CLOSURE, 2 ROOT_WINNER, 3 ROOT_FAILED
const l1Standing = (idx, finishedAt = 0) => [
  toFunctionSelector("tournamentStanding()"),
  enc("(uint8,bool,bool,bytes32,bytes32,bytes32,uint64,uint64)", [[idx, false, false, H(0), H(0), H(0), BigInt(finishedAt), 0n]]),
];
const l1Uint = (sig, n) => [toFunctionSelector(sig), enc("uint256", [BigInt(n)])];
const chain = (...pairs) => Object.fromEntries(pairs);

// -------------------------------------------------------------
// scenarios: method -> result | { error } | (params) => ...
// -------------------------------------------------------------
const nodeInfo = { data: { chain_id: hex(CHAIN_ID), version: "2.0.0-alpha.13-798", default_block: "LATEST" } };
const outputs = Array.from({ length: 7 }, (_, i) => output(i));
const listOutputs = (p) => {
  const rows = p.descending ? [...outputs].reverse() : outputs;
  return page(rows.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 50)), outputs.length);
};

const SCENARIOS = {
  // PRT, epoch 1 sealed and disputed, epoch 2 open. Expect: PRT pill, settling
  // row, dispute row naming epoch #1, seven leaderboard rows, no note.
  dispute: {
    hash: "#how", // open the How-it-works modal so its steps are in the DOM text
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { data: application() },
    cartesi_getLastAcceptedEpochIndex: { data: hex(0) },
    cartesi_listEpochs: (p) => {
      if (p.status) return page([epoch(1, "CLAIM_SUBMITTED")]);
      return page([epoch(2, "OPEN")], 3);
    },
    cartesi_listOutputs: listOutputs,
    cartesi_listTournaments: page([
      tournament(T_ROOT, 0, null, "MATCHES_ACTIVE"),
      tournament(T_INNER, 1, T_ROOT, "MATCHES_ACTIVE"),
    ]),
    cartesi_listCommitments: page([
      commitment(T_ROOT, H(21), false, 0),
      commitment(T_ROOT, H(22), true, 1200),
    ]),
    cartesi_listMatches: page([match(T_ROOT, H(51), H(21), H(22))]),
    cartesi_getEpoch: (p) => ({ data: epoch(Number(p.epoch_index), Number(p.epoch_index) === 1 ? "CLAIM_SUBMITTED" : "CLAIM_ACCEPTED") }),
    l1: chain(
      l1Sealed(1, T_ROOT, false, 0, 1, 3),
      l1CanStage(false, false),
      l1Standing(0),
      l1Uint("getCommitmentJoinedCount()", 2),
    ),
    expect: [
      "PRT",
      // settling row: contract phase first, the node's label as a note
      "DISPUTE ACTIVE",
      "epoch #1",
      "node: IN TOURNAMENT",
      "2 commitments · 1/1 matches active · 2 tournaments",
      // open and accepted rows
      "epoch #2",
      "ACCEPTED",
      "epoch #0",
      "2 inputs",
      "7 runs",
      "STEP 05",
      "Verify the score onchain",
    ],
    forbid: ["config mismatch", "unsupported node", "live unreachable", "no runs yet", "settling epoch", "last accepted epoch"],
  },

  // PRT, claim staged at block 950 with a 100-block staging period; the chain
  // is at 1000 and every sentry agrees. Expect the countdown line.
  staged: {
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { data: application() },
    cartesi_getLastAcceptedEpochIndex: { data: hex(0) },
    cartesi_listEpochs: (p) =>
      p.status
        ? page([epoch(1, "CLAIM_STAGED", { staged_at_block: hex(950) })])
        : page([epoch(2, "OPEN")], 3),
    cartesi_listOutputs: listOutputs,
    cartesi_listTournaments: page([tournament(T_ROOT, 0, null, "ROOT_WINNER")]),
    cartesi_listCommitments: page([commitment(T_ROOT, H(21), false, 0)]),
    cartesi_listMatches: page([]),
    cartesi_getEpoch: (p) => ({ data: epoch(Number(p.epoch_index), "CLAIM_ACCEPTED") }),
    l1: {
      // canAcceptStagedTournamentResult(): staged, no sentries (fast path false), period not over
      [toFunctionSelector("canAcceptStagedTournamentResult()")]: encodeAbiParameters(
        parseAbiParameters("bool, bool, bool, uint256, bytes32, bytes32"),
        [true, false, false, 1n, H(1), H(2)],
      ),
      [toFunctionSelector("getNumberOfSentries()")]: encodeAbiParameters(parseAbiParameters("uint256"), [0n]),
      ...chain(l1Sealed(1, T_ROOT, true, 950), l1CanStage(true, false), l1Standing(2), l1Uint("getCommitmentJoinedCount()", 1)),
    },
    expect: ["STAGED", "epoch #1", "accepts in 50\u00a0blk", "epoch #2"],
    forbid: ["DISPUTE", "config mismatch", "live unreachable", "node:", "settling epoch"],
  },

  // Mirrors the live Base Sepolia deployment on 2026-10-02: the node computed
  // epoch 0's claim and never submitted it (CLAIM_COMPUTED, no tournament
  // rows, no accepted epoch), while on-chain the tournament ran out its
  // allowance with zero commitments and reads ROOT_FAILED. The panel must say
  // what the chain says and keep the node's label as a note.
  stalenode: {
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { data: application() },
    cartesi_getLastAcceptedEpochIndex: { error: { code: -31001, message: "Epoch not found" } },
    cartesi_listEpochs: (p) =>
      p.status
        ? page([epoch(0, "CLAIM_COMPUTED", { input_index_lower_bound: hex(0), input_index_upper_bound: hex(0) })])
        : page([epoch(1, "OPEN", { input_index_lower_bound: hex(0), input_index_upper_bound: hex(4) })], 2),
    cartesi_getEpoch: (p) => ({ data: epoch(Number(p.epoch_index), Number(p.epoch_index) === 0 ? "CLAIM_COMPUTED" : "OPEN") }),
    cartesi_listOutputs: listOutputs,
    cartesi_listTournaments: page([]),
    cartesi_listCommitments: page([]),
    cartesi_listMatches: page([]),
    l1: chain(
      l1Sealed(0, T_ROOT, false, 0, 0, 0),
      l1CanStage(true, true),
      l1Standing(3, 900),
      l1Uint("getCommitmentJoinedCount()", 0),
      l1Uint("getMatchCreatedCount()", 0),
      l1Uint("getMatchDeletedCount()", 0),
      l1Uint("getNewInnerTournamentCount()", 0),
    ),
    expect: [
      "PRT",
      "OPEN",
      "epoch #1",
      "4 inputs",
      "TOURNAMENT FAILED",
      "epoch #0",
      "0 inputs",
      "no claim within allowance",
      "node: CLAIM COMPUTED",
      "no accepted epoch yet",
      "7 runs",
    ],
    forbid: ["0xA18d", "settling epoch", "last accepted epoch", "live unreachable", "config mismatch", "DISPUTE"],
  },

  // Authority, nothing disputed, no accepted epoch yet (-31001 is not an error).
  authority: {
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { data: application({ consensus_type: "AUTHORITY" }) },
    cartesi_getLastAcceptedEpochIndex: { error: { code: -31001, message: "epoch not found" } },
    cartesi_listEpochs: (p) => (p.status ? page([]) : page([epoch(0, "OPEN")])),
    cartesi_listOutputs: () => page([]),
    expect: ["AUTHORITY", "no runs yet", "epoch #0", "no accepted epoch yet"],
    forbid: ["live unreachable", "settling epoch", "config mismatch", "TOURNAMENT", "node:"],
  },

  // Same node, but the site was built for another InputBox.
  mismatch: {
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { data: application({ iinputbox_address: getAddress("0x" + "ee".repeat(20)) }) },
    cartesi_getLastAcceptedEpochIndex: { data: hex(0) },
    cartesi_listEpochs: () => page([epoch(0, "OPEN")]),
    cartesi_listOutputs: listOutputs,
    expect: ["config mismatch", "submissions disabled", `node InputBox is ${getAddress("0x" + "ee".repeat(20))}`],
    forbid: ["unsupported node"],
  },

  // An alpha.12-era node: no cartesi_getNodeInfo.
  oldnode: {
    cartesi_getNodeVersion: { data: "2.0.0-alpha.12" },
    cartesi_getApplication: { data: application() },
    cartesi_listOutputs: listOutputs,
    expect: ["unsupported node", "next/2.0", "7 runs"],
    forbid: ["config mismatch"],
  },

  // Unknown application name: a config error, shown once, no retry storm.
  noapp: {
    cartesi_getNodeInfo: nodeInfo,
    cartesi_getApplication: { error: { code: -31002, message: "application not found" } },
    cartesi_listOutputs: { error: { code: -31002, message: "application not found" } },
    expect: ["node rejected the request", "application not found", "live unreachable"],
    forbid: ["config mismatch", "unsupported node"],
  },
};

// Scenarios that drive the page from inside: a <script type="module"> is
// injected into index.html (see staticSite) and plays the user. No wallet
// exists in headless Chrome, so a genuine submission ends in
// "submit failed · wallet not connected" — which is exactly how the two
// paths are told apart.
const driveSleep = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`;
const finishMsg = (outhashByte, tape) =>
  `window.postMessage({ rivemuOnFinish: true, outhash: "${outhashByte}".repeat(32), tape: new Uint8Array([${tape.join(",")}]) }, "*");`;

// Exiting a replay resets the emulator, which reports the stop as a finish
// carrying the replayed tape. That finish must never become a submission.
SCENARIOS.replayexit = {
  ...SCENARIOS.dispute,
  hash: "",
  cartesi_getInput: (p) => ({ data: input(Number(p.input_index)) }),
  hooks: `${driveSleep}
    await sleep(2000);                                   // board rendered
    document.querySelector(".col-play").click();         // loadReplay(0)
    await sleep(1000);                                   // getInput resolved, tape remembered
    document.getElementById("exit-replay").click();      // teardown
    await sleep(200);
    ${finishMsg("ab", REPLAY_TAPE)}                      // what the emulator emits on stop`,
  expect: ["replay stopped", "7 runs"],
  forbid: ["submitting", "submit failed", "retry submit", "wallet not connected"],
};

// Same sequence, then a finish with a different tape: a real recording, which
// must go down the submit path (and fail here for lack of a wallet).
SCENARIOS.newrun = {
  ...SCENARIOS.replayexit,
  hooks: `${SCENARIOS.replayexit.hooks}
    await sleep(300);
    ${finishMsg("11", [9, 9, 9])}`,
  expect: ["submit failed · wallet not connected", "retry submit", "your run is kept"],
  forbid: ["replay stopped", "check status", "send again anyway"],
};

// -------------------------------------------------------------
// servers
// -------------------------------------------------------------
function cors(res) {
  res.setHeader("access-control-allow-origin", SITE_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
}

function fakeNode(scenario) {
  const seen = [];
  const answer = (req) => {
    seen.push(req.method);
    const h = scenario[req.method];
    if (h === undefined)
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    const r = typeof h === "function" ? h(req.params ?? {}) : h;
    if (r && r.error) return { jsonrpc: "2.0", id: req.id, error: r.error };
    return { jsonrpc: "2.0", id: req.id, result: r };
  };
  const server = http.createServer((req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  return { server, seen };
}

// Minimal Ethereum JSON-RPC: block number, chain id, and eth_call answered by
// selector from `calls` (anything else reverts). Handles viem's batches.
function fakeL1(calls = {}, seen = []) {
  const answer = (req) => {
    const id = req.id;
    seen.push(req.method === "eth_call" ? `eth_call ${(req.params?.[0]?.data ?? "0x").slice(0, 10)}` : req.method);
    switch (req.method) {
      case "eth_chainId":
        return { jsonrpc: "2.0", id, result: hex(CHAIN_ID) };
      case "eth_blockNumber":
        return { jsonrpc: "2.0", id, result: hex(L1_BLOCK) };
      case "eth_call": {
        const data = req.params?.[0]?.data ?? "0x";
        const out = calls[data.slice(0, 10).toLowerCase()];
        if (out) return { jsonrpc: "2.0", id, result: out };
        return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted" } };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
    }
  };
  return http.createServer((req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
}

// `hooksFor()` returns the current scenario's driver script (or null); it is
// appended to index.html as a module so it runs after main.js.
function staticSite(dir, hooksFor = () => null) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" };
  return http.createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = join(dir, path);
    if (!existsSync(file)) return res.writeHead(404).end();
    const ext = path.slice(path.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    let body = readFileSync(file);
    const hooks = path === "/index.html" ? hooksFor() : null;
    if (hooks)
      body = Buffer.from(
        body.toString("utf8").replace("</body>", `<script type="module">${hooks}</script></body>`),
      );
    res.end(body);
  });
}

// Default host = dual-stack, because Chrome may resolve "localhost" to ::1
// while Node resolves it to 127.0.0.1. A literal IP binds just that address.
const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
const hostFor = (url) => (/^[\d.]+$|^\[/.test(url.hostname) ? url.hostname.replace(/^\[|\]$/g, "") : undefined);

// -------------------------------------------------------------
// chrome
// -------------------------------------------------------------
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).sort().reverse();
  for (const d of dirs) {
    for (const rel of [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/headless_shell",
      "chrome-linux/chrome",
    ]) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// Async on purpose: the fake node and the static site run in THIS process, so
// a blocking spawn would starve them and Chrome would see a dead server.
function render(chrome, url) {
  const args = [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--enable-logging=stderr",
    "--v=0",
    // --dump-dom fires at the load event; the page's fetches finish later.
    // A virtual-time budget lets pending timers and requests run first. The
    // emulator iframe points at an unreachable port so it cannot stall it.
    `--virtual-time-budget=${RENDER_MS}`,
    "--dump-dom",
    url,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      chrome,
      args,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: RENDER_MS + 30_000 },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(err);
        const consoleLines = stderr.match(/:(INFO|WARNING|ERROR):CONSOLE[^\n]*"[^"]*"/g) ?? [];
        const consoleAll = consoleLines.map((l) => l.replace(/^.*?"(.*)"$/, "$1"));
        // console.warn is how the page reports expected trouble; only
        // console.error and uncaught exceptions count as failures.
        const consoleErrors = consoleLines
          .filter((l) => /:ERROR:CONSOLE/.test(l) || /Uncaught/.test(l))
          .map((l) => l.replace(/^.*?"(.*)"$/, "$1"));
        resolve({ html: stdout, consoleErrors, consoleAll });
      },
    );
  });
}

// Visible text only: elements carrying the `hidden` attribute (and their
// subtrees) are skipped, since the panel keeps every row in the DOM and toggles
// `hidden`. A small tag walker is enough for this page; no DOM library needed.
function textOf(html) {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "");
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr"]);
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let out = "";
  let last = 0;
  const stack = []; // true when the element is hidden
  let hiddenDepth = 0;
  let m;
  while ((m = tagRe.exec(body))) {
    if (hiddenDepth === 0) out += body.slice(last, m.index);
    last = tagRe.lastIndex;
    const [, close, name, attrs] = m;
    const tag = name.toLowerCase();
    if (close) {
      // Pop to the matching open tag; a stray close tag is ignored rather than
      // allowed to unwind (and corrupt) the hidden depth.
      let at = -1;
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { at = i; break; }
      if (at >= 0) {
        for (const popped of stack.splice(at)) if (popped.hidden) hiddenDepth--;
      }
      continue;
    }
    if (VOID.has(tag) || attrs.endsWith("/")) continue;
    const hidden = /(^|\s)hidden(=|\s|$)/.test(attrs) || /display:\s*none/.test(attrs);
    stack.push({ tag, hidden });
    if (hidden) hiddenDepth++;
  }
  if (hiddenDepth === 0) out += body.slice(last);
  return out
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\r\n]+/g, " ");
}

// -------------------------------------------------------------
// main
// -------------------------------------------------------------
const chrome = findChrome();
if (!chrome) {
  console.error("no Chrome found; set CHROME=/path/to/chrome");
  process.exit(2);
}
const only = process.argv[2];
const keys = only ? [only] : Object.keys(SCENARIOS);
let failures = 0;
const siteDir = await buildSite();
let currentHooks = null;
const site = await listen(staticSite(siteDir, () => currentHooks), SITE_PORT, SITE_HOST);

for (const key of keys) {
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.error(`unknown scenario ${key}`);
    process.exit(2);
  }
  currentHooks = scenario.hooks ?? null;
  const { server, seen } = fakeNode(scenario);
  await listen(server, Number(nodeUrl.port), hostFor(nodeUrl));
  const l1seen = [];
  const l1 = fakeL1(
    Object.fromEntries(Object.entries(scenario.l1 ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    l1seen,
  );
  await listen(l1, Number(L1_URL.port), hostFor(L1_URL));
  let result;
  try {
    result = await render(chrome, `${SITE_ORIGIN}/${scenario.hash ?? ""}`);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => l1.close(r));
  }
  const text = textOf(result.html);
  console.log(`\n== ${key}  (${seen.length} node calls: ${[...new Set(seen)].join(", ")}; l1: ${l1seen.join(", ") || "none"})`);
  for (const s of scenario.expect ?? []) {
    const ok = text.includes(s);
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  shows "${s}"`);
  }
  for (const s of scenario.forbid ?? []) {
    const ok = !text.includes(s);
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  does not show "${s}"`);
  }
  const noErrors = result.consoleErrors.length === 0;
  if (!noErrors) failures++;
  console.log(`  ${noErrors ? "PASS" : "FAIL"}  no console errors${noErrors ? "" : ": " + result.consoleErrors.join(" | ")}`);
  // Configuration errors must not turn into a retry storm within the budget.
  if (key === "noapp" || key === "oldnode") {
    const n = seen.filter((m) => m === "cartesi_getApplication" || m === "cartesi_getNodeInfo").length;
    const ok = n <= 3;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  no retry storm (${n} gate calls)`);
  }
  if (process.env.DEBUG) {
    for (const l of result.consoleAll) console.log("  console:", l.slice(0, 300));
    console.log(text.slice(0, 4000));
  }
}

await new Promise((r) => site.close(r));
rmSync(siteDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
