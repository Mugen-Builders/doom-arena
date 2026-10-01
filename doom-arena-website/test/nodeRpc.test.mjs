// Run with: npm test   (node's built-in runner, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress } from "viem";

import {
  RPC_ERROR,
  NodeRpcError,
  NodeShapeError,
  NodeTransportError,
  isNotFound,
  isConfigError,
  isTransient,
  isUnsupportedNode,
  MAPPERS,
  OUTPUT_SELECTOR,
  calls,
  createNodeClient,
  listAllOutputs,
  toOutput,
  toTournament,
  toEpoch,
  toApplication,
  MAX_BATCH,
} from "../src/nodeRpc.js";

const discover = JSON.parse(
  readFileSync(new URL("./fixtures/jsonrpc-discover.json", import.meta.url), "utf8"),
);
const SCHEMAS = discover.components.schemas;
const METHODS = Object.fromEntries(discover.methods.map((m) => [m.name, m]));

const Z = "0x" + "0".repeat(40);
const A1 = "0x" + "a".repeat(40);
const A1_CHECKSUMMED = getAddress(A1);
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const NOW = "2026-09-30T12:00:00Z";

// -------------------------------------------------------------
// 1. schema drift — every wire field a mapper reads is declared by the node
// -------------------------------------------------------------
test("every mapper targets a schema the node declares", () => {
  for (const m of MAPPERS) {
    assert.ok(SCHEMAS[m.schemaName], `schema ${m.schemaName} missing from rpc.discover`);
  }
});

test("every wire field a mapper reads is a declared property", () => {
  for (const m of MAPPERS) {
    const props = SCHEMAS[m.schemaName].properties ?? {};
    for (const [camel, [wire]] of Object.entries(m.fields)) {
      assert.ok(
        props[wire],
        `${m.schemaName}.${wire} (mapped to ${camel}) is not in rpc.discover`,
      );
    }
  }
});

test("required mapper fields are not nullable in the schema", () => {
  const nullable = (p) =>
    (Array.isArray(p.type) && p.type.includes("null")) ||
    (p.oneOf ?? []).some((o) => o.type === "null");
  for (const m of MAPPERS) {
    const props = SCHEMAS[m.schemaName].properties ?? {};
    for (const [, [wire, , required]] of Object.entries(m.fields)) {
      if (!required) continue;
      assert.ok(
        !nullable(props[wire]),
        `${m.schemaName}.${wire} is required by the client but nullable on the wire`,
      );
    }
  }
});

test("nested mappers point at the schema the parent property references", () => {
  const refOf = (p) => {
    const r =
      p.$ref ??
      (p.oneOf ?? []).find((o) => o.$ref)?.$ref ??
      (p.allOf ?? []).find((o) => o.$ref)?.$ref;
    return r ? r.split("/").pop() : null;
  };
  for (const m of MAPPERS) {
    const props = SCHEMAS[m.schemaName].properties ?? {};
    for (const [, [wire, convert]] of Object.entries(m.fields)) {
      if (!convert.schemaName) continue;
      const ref = refOf(props[wire]);
      assert.equal(
        ref,
        convert.schemaName,
        `${m.schemaName}.${wire} references ${ref}, mapper says ${convert.schemaName}`,
      );
    }
  }
});

test("every call uses a declared method and only declared params", () => {
  const sample = {
    application: "app",
    epochIndex: 1n,
    inputIndex: 1n,
    level: 0n,
    from: 0n,
    to: 9n,
    status: "OPEN",
    outputType: OUTPUT_SELECTOR.Notice,
    voucherAddress: A1,
    executed: false,
    tournamentAddress: A1,
    parentTournamentAddress: A1,
    parentMatchIdHash: H(1),
    limit: 10,
    offset: 0,
    descending: true,
  };
  for (const [name, make] of Object.entries(calls)) {
    const d = make(sample);
    const m = METHODS[d.method];
    assert.ok(m, `${name}: ${d.method} is not in rpc.discover`);
    const declared = new Set(m.params.map((p) => p.name));
    const sent = Array.isArray(d.params) ? [] : Object.keys(d.params);
    for (const k of sent) assert.ok(declared.has(k), `${d.method}: param ${k} not declared`);
    for (const p of m.params.filter((p) => p.required))
      assert.ok(sent.includes(p.name), `${d.method}: required param ${p.name} not sent`);
  }
});

test("error codes match the node's error catalogue", () => {
  const codes = Object.fromEntries(
    Object.entries(discover.components.errors).map(([k, v]) => [k, v.code]),
  );
  assert.equal(RPC_ERROR.NOT_FOUND, codes.EpochNotFound);
  assert.equal(RPC_ERROR.APP_NOT_FOUND, codes.ApplicationNotFound);
  assert.equal(RPC_ERROR.RESPONSE_TOO_LARGE, codes.ResponseSizeLimitExceeded);
  assert.equal(RPC_ERROR.BATCH_BUDGET, codes.BatchListItemLimitExceeded);
  assert.equal(RPC_ERROR.TIMEOUT, codes.TimeoutError);
  assert.equal(RPC_ERROR.INVALID_PARAMS, codes.InvalidParams);
  assert.equal(RPC_ERROR.INTERNAL, codes.InternalError);
});

// -------------------------------------------------------------
// 2. param encoding
// -------------------------------------------------------------
test("indices are hex, limit/offset are integers, undefined is dropped", () => {
  const d = calls.listOutputs({
    application: "app",
    epochIndex: 255n,
    inputIndex: 3,
    limit: 100,
    offset: 0,
    descending: true,
  });
  assert.deepEqual(d.params, {
    application: "app",
    epoch_index: "0xff",
    input_index: "0x3",
    limit: 100,
    offset: 0,
    descending: true,
  });
});

test("status and output_type accept a scalar or an array", () => {
  assert.deepEqual(calls.listEpochs({ application: "a", status: "OPEN" }).params.status, [
    "OPEN",
  ]);
  assert.deepEqual(
    calls.listEpochs({ application: "a", status: ["OPEN", "CLOSED"] }).params.status,
    ["OPEN", "CLOSED"],
  );
  assert.deepEqual(
    calls.listOutputs({ application: "a", outputType: OUTPUT_SELECTOR.Notice }).params
      .output_type,
    [OUTPUT_SELECTOR.Notice],
  );
});

test("a negative or fractional limit is rejected before it reaches the node", () => {
  assert.throws(() => calls.listEpochs({ application: "a", limit: -1 }));
  assert.throws(() => calls.listEpochs({ application: "a", limit: 1.5 }));
});

test("output selectors match the Outputs ABI", () => {
  assert.equal(OUTPUT_SELECTOR.Notice, "0xc258d6e5");
  assert.equal(OUTPUT_SELECTOR.Voucher, "0x237a816f");
  assert.equal(OUTPUT_SELECTOR.DelegateCallVoucher, "0x10321e8b");
});

// -------------------------------------------------------------
// 3. mapping
// -------------------------------------------------------------
const rawEpoch = (extra = {}) => ({
  index: "0x2",
  status: "CLAIM_STAGED",
  first_block: "0x10",
  last_block: "0x19",
  input_index_lower_bound: "0x0",
  input_index_upper_bound: "0x5",
  machine_hash: H(9),
  commitment: null,
  claim_transaction_hash: null,
  tournament_address: A1,
  staged_at_block: "0x20",
  virtual_index: "0x2",
  created_at: NOW,
  updated_at: NOW,
  ...extra,
});

test("epoch: hex to bigint, addresses checksummed, nulls preserved", () => {
  const e = toEpoch(rawEpoch());
  assert.equal(e.index, 2n);
  assert.equal(e.inputIndexUpperBound, 5n);
  assert.equal(e.stagedAtBlock, 32n);
  assert.equal(e.tournamentAddress, A1_CHECKSUMMED);
  assert.equal(e.commitment, null);
  assert.ok(e.updatedAt instanceof Date);
});

test("epoch: a missing required field is a NodeShapeError naming it", () => {
  assert.throws(
    () => toEpoch(rawEpoch({ status: undefined }), "cartesi_listEpochs"),
    (e) =>
      e instanceof NodeShapeError &&
      e.field === "Epoch.status" &&
      e.method === "cartesi_listEpochs",
  );
});

test("epoch: a malformed value is a NodeShapeError, not a viem stack trace", () => {
  assert.throws(
    () => toEpoch(rawEpoch({ index: 12 })),
    (e) => e instanceof NodeShapeError && e.field === "Epoch.index",
  );
});

test("epoch: fields this node no longer serves come back null, not undefined", () => {
  const e = toEpoch(rawEpoch({ staged_at_block: undefined }));
  assert.equal(e.stagedAtBlock, null);
  assert.ok(!("outputsMerkleRoot" in e));
});

test("application: no data_availability needed (removed in PR #798)", () => {
  const a = toApplication({
    name: "doom_arena",
    iapplication_address: A1,
    iconsensus_address: A1,
    iinputbox_address: A1,
    consensus_type: "PRT",
    claim_staging_period: "0x14",
    epoch_length: "0xa",
    status: "OK",
    reason: null,
    enabled: true,
  });
  assert.equal(a.consensusType, "PRT");
  assert.equal(a.claimStagingPeriod, 20n);
  assert.equal(a.inputBoxAddress, A1_CHECKSUMMED);
});

const rawOutput = (decoded) => ({
  epoch_index: "0x0",
  input_index: "0x1",
  index: "0x7",
  raw_data: "0xc258d6e5",
  decoded_data: decoded,
  hash: H(3),
  output_hashes_siblings: [H(1), H(2)],
  execution_transaction_hash: null,
  created_at: NOW,
  updated_at: NOW,
});

test("output: notice type is normalised whether served as name or selector", () => {
  for (const type of ["Notice", "notice", OUTPUT_SELECTOR.Notice, "0xC258D6E5"]) {
    const o = toOutput(rawOutput({ type, payload: "0x1234" }));
    assert.equal(o.decodedData.type, "Notice", `type=${type}`);
    assert.equal(o.decodedData.payload, "0x1234");
  }
});

test("output: vouchers carry destination and value; unknown types are rejected", () => {
  const o = toOutput(
    rawOutput({ type: OUTPUT_SELECTOR.Voucher, destination: A1, value: "0xde0b6b3a7640000", payload: "0x" }),
  );
  assert.equal(o.decodedData.type, "Voucher");
  assert.equal(o.decodedData.value, 10n ** 18n);
  assert.throws(() => toOutput(rawOutput({ type: "0xdeadbeef", payload: "0x" })));
});

test("output: undecodable output has null decodedData and keeps its proof", () => {
  const o = toOutput(rawOutput(null));
  assert.equal(o.decodedData, null);
  assert.deepEqual(o.outputHashesSiblings, [H(1), H(2)]);
  assert.equal(o.index, 7n);
});

test("tournament: snapshot maps, and its absence is null rather than a throw", () => {
  const base = {
    epoch_index: "0x0",
    address: A1,
    parent_tournament_address: null,
    parent_match_id_hash: null,
    max_level: "0x3",
    level: "0x0",
    log2step: "0x2c",
    height: "0x30",
    kind: "NON_LEAF",
    created_at: NOW,
    updated_at: NOW,
  };
  const t = toTournament({
    ...base,
    snapshot: {
      as_of_block: "0x100",
      standing: "MATCHES_ACTIVE",
      accepts_joins: false,
      candidate: null,
      winner_commitment: null,
      final_state_hash: null,
      parent_commitment: null,
      finished_at_block: "0x0",
      winner_expires_at: "0x0",
      inner_result: null,
      bond_recovery: { disposition: "TOURNAMENT_RUNNING", claimer: null, payment: null },
    },
  });
  assert.equal(t.snapshot.standing, "MATCHES_ACTIVE");
  assert.equal(t.snapshot.asOfBlock, 256n);
  assert.equal(t.snapshot.bondRecovery.disposition, "TOURNAMENT_RUNNING");
  assert.equal(t.snapshot.innerResult, null);

  const old = toTournament({ ...base, winner_commitment: null, finished_at_block: "0x0" });
  assert.equal(old.snapshot, null);
  assert.equal(old.level, 0n);
});

// -------------------------------------------------------------
// 4. transport + errors
// -------------------------------------------------------------
// A fake fetch that answers from a table keyed by method; records requests.
function fakeNode(handlers, { status = 200 } = {}) {
  const requests = [];
  const answer = (req) => {
    const h = handlers[req.method];
    if (!h) return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
    const r = typeof h === "function" ? h(req.params) : h;
    if (r && r.__error) return { jsonrpc: "2.0", id: req.id, error: r.__error };
    return { jsonrpc: "2.0", id: req.id, result: r };
  };
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const payload = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

test("a JSON-RPC error becomes NodeRpcError with the node's code", async () => {
  const { fetch } = fakeNode({
    cartesi_getLastAcceptedEpochIndex: { __error: { code: -31001, message: "epoch not found" } },
  });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  await assert.rejects(
    c.getLastAcceptedEpochIndex({ application: "a" }),
    (e) => e instanceof NodeRpcError && e.code === -31001 && isNotFound(e),
  );
});

test("classification helpers", () => {
  const rpc = (code) => new NodeRpcError("m", code, "x");
  assert.ok(isConfigError(rpc(RPC_ERROR.APP_NOT_FOUND)));
  assert.ok(isConfigError(rpc(RPC_ERROR.INVALID_PARAMS)));
  assert.ok(!isConfigError(rpc(RPC_ERROR.NOT_FOUND)));
  assert.ok(isTransient(rpc(RPC_ERROR.TIMEOUT)));
  assert.ok(isTransient(rpc(RPC_ERROR.RESPONSE_TOO_LARGE)));
  assert.ok(isTransient(new NodeTransportError("m", "ECONNREFUSED")));
  assert.ok(!isTransient(rpc(RPC_ERROR.NOT_FOUND)));
  assert.ok(isUnsupportedNode(rpc(RPC_ERROR.METHOD_NOT_FOUND)));
  assert.ok(isUnsupportedNode(new NodeShapeError("m", "Epoch.status")));
  assert.ok(!isUnsupportedNode(rpc(RPC_ERROR.NOT_FOUND)));
});

test("an alpha.12-era node (no getNodeInfo) is reported as unsupported", async () => {
  const { fetch } = fakeNode({ cartesi_getNodeVersion: { data: "2.0.0-alpha.12" } });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  await assert.rejects(c.getNodeInfo(), (e) => isUnsupportedNode(e));
});

test("getNodeInfo maps chain id to a number", async () => {
  const { fetch } = fakeNode({
    cartesi_getNodeInfo: { data: { chain_id: "0x7a69", version: "2.0.0-alpha.13", default_block: "LATEST" } },
  });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const info = await c.getNodeInfo();
  assert.deepEqual(info, { chainId: 31337, version: "2.0.0-alpha.13", defaultBlock: "LATEST" });
});

test("HTTP failure and non-JSON bodies are NodeTransportError", async () => {
  const c1 = createNodeClient({
    url: "http://node/rpc",
    fetch: async () => new Response("nope", { status: 502 }),
  });
  await assert.rejects(c1.getNodeInfo(), (e) => e instanceof NodeTransportError && /502/.test(e.message));
  const c2 = createNodeClient({
    url: "http://node/rpc",
    fetch: async () => new Response("<html>", { status: 200 }),
  });
  await assert.rejects(c2.getNodeInfo(), (e) => e instanceof NodeTransportError);
  const c3 = createNodeClient({
    url: "http://node/rpc",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(c3.getNodeInfo(), (e) => e instanceof NodeTransportError && isTransient(e));
});

test("a wrong-shaped success is a NodeShapeError at the boundary", async () => {
  const { fetch } = fakeNode({ cartesi_listEpochs: { data: [{ index: "0x0" }], pagination: { total_count: 1 } } });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  await assert.rejects(c.listEpochs({ application: "a" }), (e) => e instanceof NodeShapeError && e.field === "Epoch.status");
});

test("batch: one HTTP request, results in request order, per-entry errors do not reject", async () => {
  const { fetch, requests } = fakeNode({
    cartesi_getLastAcceptedEpochIndex: { data: "0x4" },
    cartesi_listEpochs: { data: [rawEpoch()], pagination: { total_count: 1, limit: 1, offset: 0 } },
  });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const res = await c.batch([
    calls.listEpochs({ application: "a", limit: 1 }),
    calls.getNodeInfo(),
    calls.getLastAcceptedEpochIndex({ application: "a" }),
  ]);
  assert.equal(requests.length, 1);
  assert.ok(Array.isArray(requests[0]) && requests[0].length === 3);
  assert.equal(res[0].ok, true);
  assert.equal(res[0].value.data[0].index, 2n);
  assert.equal(res[1].ok, false);
  assert.ok(res[1].error instanceof NodeRpcError);
  assert.equal(res[2].ok, true);
  assert.equal(res[2].value, 4n);
});

test("batch: a whole-batch rejection fails every entry with the same error", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -31004, message: "budget" } }));
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const res = await c.batch([calls.getNodeInfo(), calls.getNodeInfo()]);
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => !r.ok && r.error.code === -31004));
});

test("batch: the node's 100-entry limit is enforced client-side", async () => {
  const c = createNodeClient({ url: "http://node/rpc", fetch: async () => new Response("[]") });
  await assert.rejects(c.batch(Array.from({ length: MAX_BATCH + 1 }, () => calls.getNodeInfo())));
});

// -------------------------------------------------------------
// 5. listAllOutputs paging
// -------------------------------------------------------------
function outputsNode(total) {
  // Newest first when descending, like the node.
  const all = Array.from({ length: total }, (_, i) => rawOutput({ type: "Notice", payload: "0x" }))
    .map((o, i) => ({ ...o, index: "0x" + i.toString(16) }));
  return fakeNode({
    cartesi_listOutputs: (p) => {
      const ordered = p.descending ? [...all].reverse() : all;
      const page = ordered.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 50));
      return { data: page, pagination: { total_count: total, limit: p.limit ?? 50, offset: p.offset ?? 0 } };
    },
  });
}

test("listAllOutputs: exhausts the collection in one first page + one batch", async () => {
  const { fetch, requests } = outputsNode(250);
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const r = await listAllOutputs(c, { application: "a", descending: true, pageSize: 100, cap: 2000 });
  assert.equal(r.data.length, 250);
  assert.equal(r.totalCount, 250);
  assert.equal(r.truncated, false);
  assert.equal(requests.length, 2); // first page, then a batch of two
  assert.equal(requests[1].length, 2);
  assert.equal(r.data[0].index, 249n); // newest first
  assert.equal(new Set(r.data.map((o) => o.index)).size, 250);
});

test("listAllOutputs: stops at the cap and reports truncation", async () => {
  const { fetch, requests } = outputsNode(5000);
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const r = await listAllOutputs(c, { application: "a", descending: true, pageSize: 100, cap: 2000 });
  assert.equal(r.data.length, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.totalCount, 5000);
  const limits = requests[1].map((q) => q.params.limit);
  assert.equal(limits.reduce((a, b) => a + b, 0), 1900);
  assert.ok(limits.every((l) => l <= 100));
});

test("listAllOutputs: a single short page needs no batch at all", async () => {
  const { fetch, requests } = outputsNode(7);
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const r = await listAllOutputs(c, { application: "a", pageSize: 100 });
  assert.equal(r.data.length, 7);
  assert.equal(requests.length, 1);
});

test("listAllOutputs: an empty collection", async () => {
  const { fetch } = outputsNode(0);
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  const r = await listAllOutputs(c, { application: "a" });
  assert.deepEqual(r, { data: [], totalCount: 0, truncated: false });
});

test("listAllOutputs: a failing page surfaces as a rejection, not a silent short board", async () => {
  const { fetch } = fakeNode({
    cartesi_listOutputs: (p) =>
      p.offset === 0
        ? { data: Array.from({ length: 100 }, (_, i) => ({ ...rawOutput(null), index: "0x" + i.toString(16) })), pagination: { total_count: 150, limit: 100, offset: 0 } }
        : { __error: { code: -32070, message: "timeout" } },
  });
  const c = createNodeClient({ url: "http://node/rpc", fetch });
  await assert.rejects(listAllOutputs(c, { application: "a", pageSize: 100 }), (e) => isTransient(e));
});
