// =============================================================
// rollups-node JSON-RPC — thin client
// =============================================================
// Targets rollups-node `next/2.0` with PR #798 (rpc.discover pinned in
// test/fixtures/jsonrpc-discover.json). Only the methods this site uses are
// wrapped. Names mirror @cartesi/client's camelCase output so a future move
// back to rollups-ts is a swap of this file, not of its callers.
//
// Shape policy: an optional wire field that is absent or null maps to null; a
// REQUIRED wire field that is absent throws NodeShapeError naming the field.
// A node of the wrong generation therefore fails loudly at the boundary
// instead of rendering nonsense downstream.
//
// The client does not retry. Polling and backoff belong to the caller.
// =============================================================

import { getAddress, hexToBigInt, numberToHex, toFunctionSelector } from "viem";

// -------------------------------------------------------------
// errors
// -------------------------------------------------------------
export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TIMEOUT: -32070,
  BATCH_TOO_LARGE: -32040,
  NOT_FOUND: -31001,
  APP_NOT_FOUND: -31002,
  RESPONSE_TOO_LARGE: -31003,
  BATCH_BUDGET: -31004,
};

/** The node answered with a JSON-RPC error object. */
export class NodeRpcError extends Error {
  constructor(method, code, message) {
    super(`${method}: ${message} (${code})`);
    this.name = "NodeRpcError";
    this.method = method;
    this.code = code;
    this.rpcMessage = message;
  }
}

/** The node answered, but the payload lacks a field this client requires. */
export class NodeShapeError extends Error {
  constructor(method, field, detail) {
    super(
      `${method}: unexpected response shape at ${field}${detail ? ` (${detail})` : ""}`,
    );
    this.name = "NodeShapeError";
    this.method = method;
    this.field = field;
  }
}

/** No usable JSON-RPC answer at all: network, HTTP status, non-JSON body. */
export class NodeTransportError extends Error {
  constructor(method, message, cause) {
    super(`${method}: ${message}`);
    this.name = "NodeTransportError";
    this.method = method;
    this.cause = cause;
  }
}

export const isNotFound = (e) =>
  e instanceof NodeRpcError && e.code === RPC_ERROR.NOT_FOUND;

// Will not resolve by retrying: the request itself is wrong for this node.
export const isConfigError = (e) =>
  e instanceof NodeRpcError &&
  (e.code === RPC_ERROR.APP_NOT_FOUND || e.code === RPC_ERROR.INVALID_PARAMS);

// Worth retrying later, with backoff.
export const isTransient = (e) =>
  e instanceof NodeTransportError ||
  (e instanceof NodeRpcError &&
    (e.code === RPC_ERROR.TIMEOUT ||
      e.code === RPC_ERROR.RESPONSE_TOO_LARGE ||
      e.code === RPC_ERROR.BATCH_BUDGET ||
      e.code === RPC_ERROR.INTERNAL));

// The endpoint speaks JSON-RPC but is not the node generation we target.
export const isUnsupportedNode = (e) =>
  e instanceof NodeShapeError ||
  (e instanceof NodeRpcError && e.code === RPC_ERROR.METHOD_NOT_FOUND);

// -------------------------------------------------------------
// value converters (wire -> JS)
// -------------------------------------------------------------
const HEX_RE = /^0x[0-9a-fA-F]*$/;

const hexString = (v) => {
  if (typeof v !== "string" || !HEX_RE.test(v)) throw new Error("not hex");
  return v;
};
const u64 = (v) => hexToBigInt(hexString(v));
const uint = (v) => hexToBigInt(hexString(v));
const num = (v) => {
  if (typeof v !== "number") throw new Error("not a number");
  return v;
};
const str = (v) => {
  if (typeof v !== "string") throw new Error("not a string");
  return v;
};
const bool = (v) => {
  if (typeof v !== "boolean") throw new Error("not a boolean");
  return v;
};
const hash = hexString;
const bytes = hexString;
const addr = (v) => getAddress(hexString(v));
const date = (v) => {
  const d = new Date(str(v));
  if (isNaN(d.getTime())) throw new Error("not a date");
  return d;
};
const hashes = (v) => {
  if (!Array.isArray(v)) throw new Error("not an array");
  return v.map(hash);
};

const REQ = true;

/**
 * Build a mapper from a field spec: { camelName: [wireName, convert, required] }.
 * The spec doubles as the list of wire fields this client depends on, which
 * the tests check against the pinned rpc.discover document.
 */
function defineMapper(schemaName, fields) {
  const fn = (raw, method = schemaName) => {
    if (raw == null) return null;
    if (typeof raw !== "object")
      throw new NodeShapeError(method, schemaName, "not an object");
    const out = {};
    for (const [camel, [wire, convert, required]] of Object.entries(fields)) {
      const v = raw[wire];
      if (v === undefined || v === null) {
        if (required) throw new NodeShapeError(method, `${schemaName}.${wire}`);
        out[camel] = null;
        continue;
      }
      try {
        out[camel] = convert(v, method);
      } catch (e) {
        if (e instanceof NodeShapeError) throw e;
        throw new NodeShapeError(method, `${schemaName}.${wire}`, e.message);
      }
    }
    return out;
  };
  fn.schemaName = schemaName;
  fn.fields = fields;
  return fn;
}

// -------------------------------------------------------------
// schemas
// -------------------------------------------------------------
export const toPagination = defineMapper("Pagination", {
  totalCount: ["total_count", num, REQ],
  limit: ["limit", num],
  offset: ["offset", num],
});

export const toNodeInfo = defineMapper("NodeInfo", {
  chainId: ["chain_id", (v) => Number(u64(v)), REQ],
  version: ["version", str, REQ],
  defaultBlock: ["default_block", str, REQ],
});

export const toApplication = defineMapper("Application", {
  name: ["name", str, REQ],
  applicationAddress: ["iapplication_address", addr, REQ],
  consensusAddress: ["iconsensus_address", addr, REQ],
  inputBoxAddress: ["iinputbox_address", addr, REQ],
  consensusType: ["consensus_type", str, REQ],
  templateHash: ["template_hash", hash],
  epochLength: ["epoch_length", u64],
  claimStagingPeriod: ["claim_staging_period", u64],
  status: ["status", str],
  reason: ["reason", str],
  enabled: ["enabled", bool],
  processedInputs: ["processed_inputs", u64],
  forecloseBlock: ["foreclose_block", u64],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

export const toEpoch = defineMapper("Epoch", {
  index: ["index", u64, REQ],
  status: ["status", str, REQ],
  firstBlock: ["first_block", u64],
  lastBlock: ["last_block", u64],
  inputIndexLowerBound: ["input_index_lower_bound", u64],
  inputIndexUpperBound: ["input_index_upper_bound", u64],
  machineHash: ["machine_hash", hash],
  commitment: ["commitment", hash],
  claimTransactionHash: ["claim_transaction_hash", hash],
  tournamentAddress: ["tournament_address", addr],
  stagedAtBlock: ["staged_at_block", u64],
  virtualIndex: ["virtual_index", u64],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

// Output selectors (first 4 bytes of raw_data), per rollups-contracts Outputs.
export const OUTPUT_SELECTOR = {
  Notice: toFunctionSelector("Notice(bytes)"),
  Voucher: toFunctionSelector("Voucher(address,uint256,bytes)"),
  DelegateCallVoucher: toFunctionSelector("DelegateCallVoucher(address,bytes)"),
};
const SELECTOR_TO_TYPE = Object.fromEntries(
  Object.entries(OUTPUT_SELECTOR).map(([k, v]) => [v.toLowerCase(), k]),
);

// `type` is documented as the selector but has been served as the name; take
// either and normalise to the name.
const outputType = (v) => {
  const s = str(v);
  if (OUTPUT_SELECTOR[s]) return s;
  const byName = Object.keys(OUTPUT_SELECTOR).find(
    (k) => k.toLowerCase() === s.toLowerCase(),
  );
  if (byName) return byName;
  const bySel = SELECTOR_TO_TYPE[s.toLowerCase()];
  if (bySel) return bySel;
  throw new Error(`unknown output type ${s}`);
};

export const toNotice = defineMapper("Notice", {
  type: ["type", outputType, REQ],
  payload: ["payload", bytes, REQ],
});
export const toVoucher = defineMapper("Voucher", {
  type: ["type", outputType, REQ],
  destination: ["destination", addr, REQ],
  value: ["value", uint, REQ],
  payload: ["payload", bytes, REQ],
});
export const toDelegateCallVoucher = defineMapper("DelegateCallVoucher", {
  type: ["type", outputType, REQ],
  destination: ["destination", addr, REQ],
  payload: ["payload", bytes, REQ],
});

const toDecodedOutput = (raw, method) => {
  const type = outputType(raw?.type);
  if (type === "Voucher") return toVoucher(raw, method);
  if (type === "DelegateCallVoucher") return toDelegateCallVoucher(raw, method);
  return toNotice(raw, method);
};
toDecodedOutput.schemaName = "DecodedOutput";
toDecodedOutput.oneOf = [toNotice, toVoucher, toDelegateCallVoucher];

export const toOutput = defineMapper("Output", {
  index: ["index", u64, REQ],
  rawData: ["raw_data", bytes, REQ],
  epochIndex: ["epoch_index", u64],
  inputIndex: ["input_index", u64],
  decodedData: ["decoded_data", toDecodedOutput],
  hash: ["hash", hash],
  outputHashesSiblings: ["output_hashes_siblings", hashes],
  executionTransactionHash: ["execution_transaction_hash", hash],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

export const toEvmAdvance = defineMapper("EvmAdvance", {
  chainId: ["chain_id", u64],
  applicationContract: ["application_contract", addr],
  sender: ["sender", addr],
  blockNumber: ["block_number", u64],
  blockTimestamp: ["block_timestamp", u64],
  prevRandao: ["prev_randao", uint],
  index: ["index", u64],
  payload: ["payload", bytes, REQ],
});

export const toInput = defineMapper("Input", {
  index: ["index", u64, REQ],
  epochIndex: ["epoch_index", u64],
  blockNumber: ["block_number", u64],
  rawData: ["raw_data", bytes],
  decodedData: ["decoded_data", toEvmAdvance],
  status: ["status", str],
  exceptionData: ["exception_data", bytes],
  machineHash: ["machine_hash", hash],
  transactionHash: ["transaction_hash", hash],
  logIndex: ["log_index", u64],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

export const toTournamentInnerResult = defineMapper("TournamentInnerResult", {
  disposition: ["disposition", str, REQ],
  parentCommitment: ["parent_commitment", hash],
  pausedAllowance: ["paused_allowance", u64],
});
export const toTournamentBondRecovery = defineMapper("TournamentBondRecovery", {
  disposition: ["disposition", str, REQ],
  claimer: ["claimer", addr],
  payment: ["payment", uint],
});
export const toTournamentSnapshot = defineMapper("TournamentSnapshot", {
  asOfBlock: ["as_of_block", u64, REQ],
  standing: ["standing", str, REQ],
  acceptsJoins: ["accepts_joins", bool],
  candidate: ["candidate", hash],
  winnerCommitment: ["winner_commitment", hash],
  finalStateHash: ["final_state_hash", hash],
  parentCommitment: ["parent_commitment", hash],
  finishedAtBlock: ["finished_at_block", u64],
  winnerExpiresAt: ["winner_expires_at", u64],
  innerResult: ["inner_result", toTournamentInnerResult],
  bondRecovery: ["bond_recovery", toTournamentBondRecovery],
});
export const toTournamentCreationEvent = defineMapper("TournamentCreationEvent", {
  blockNumber: ["block_number", u64],
  txHash: ["tx_hash", hash],
  logIndex: ["log_index", u64],
});

export const toTournament = defineMapper("Tournament", {
  address: ["address", addr, REQ],
  level: ["level", u64, REQ],
  epochIndex: ["epoch_index", u64],
  parentTournamentAddress: ["parent_tournament_address", addr],
  parentMatchIdHash: ["parent_match_id_hash", hash],
  maxLevel: ["max_level", u64],
  log2step: ["log2step", u64],
  height: ["height", u64],
  kind: ["kind", str],
  initialHash: ["initial_hash", hash],
  baseCycle: ["base_cycle", uint],
  startInstant: ["start_instant", u64],
  allowance: ["allowance", u64],
  creationEvent: ["creation_event", toTournamentCreationEvent],
  // Live contract state as of `snapshot.asOfBlock`. Absent on nodes older
  // than PR #798; callers treat null as "no live view".
  snapshot: ["snapshot", toTournamentSnapshot],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

export const toMatchBisectionSnapshot = defineMapper("MatchBisectionSnapshot", {
  revealingParent: ["revealing_parent", hash],
  waitingLeft: ["waiting_left", hash],
  waitingRight: ["waiting_right", hash],
  segmentStartPosition: ["segment_start_position", uint],
  segmentStartCycle: ["segment_start_cycle", uint],
  currentHeight: ["current_height", u64],
  responder: ["responder", str],
});
export const toMatchSealedSnapshot = defineMapper("MatchSealedSnapshot", {
  agreeState: ["agree_state", hash],
  divergencePosition: ["divergence_position", uint],
  divergenceCycle: ["divergence_cycle", uint],
  finalStateOne: ["final_state_one", hash],
  finalStateTwo: ["final_state_two", hash],
});
export const toMatchSnapshot = defineMapper("MatchSnapshot", {
  asOfBlock: ["as_of_block", u64, REQ],
  phase: ["phase", str, REQ],
  bisection: ["bisection", toMatchBisectionSnapshot],
  sealed: ["sealed", toMatchSealedSnapshot],
  timeoutOutcome: ["timeout_outcome", str],
  deferredCharge: ["deferred_charge", u64],
});
export const toLeafMatchSeal = defineMapper("LeafMatchSeal", {
  eliminableAt: ["eliminable_at", u64],
  blockNumber: ["block_number", u64],
  txHash: ["tx_hash", hash],
  logIndex: ["log_index", u64],
});

export const toMatch = defineMapper("Match", {
  idHash: ["id_hash", hash, REQ],
  tournamentAddress: ["tournament_address", addr, REQ],
  epochIndex: ["epoch_index", u64],
  commitmentOne: ["commitment_one", hash],
  commitmentTwo: ["commitment_two", hash],
  leftOfTwo: ["left_of_two", hash],
  blockNumber: ["block_number", u64],
  txHash: ["tx_hash", hash],
  logIndex: ["log_index", u64],
  winnerCommitment: ["winner_commitment", str],
  deletionReason: ["deletion_reason", str],
  deletionBlockNumber: ["deletion_block_number", u64],
  deletionTxHash: ["deletion_tx_hash", hash],
  deletionLogIndex: ["deletion_log_index", u64],
  eliminableAt: ["eliminable_at", u64],
  leafSeal: ["leaf_seal", toLeafMatchSeal],
  snapshot: ["snapshot", toMatchSnapshot],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

export const toCommitmentSnapshot = defineMapper("CommitmentSnapshot", {
  asOfBlock: ["as_of_block", u64, REQ],
  claimer: ["claimer", addr],
  clockRunning: ["clock_running", bool],
  clockDeadline: ["clock_deadline", u64],
  clockAllowance: ["clock_allowance", u64],
});

export const toCommitment = defineMapper("Commitment", {
  commitment: ["commitment", hash, REQ],
  tournamentAddress: ["tournament_address", addr, REQ],
  epochIndex: ["epoch_index", u64],
  finalStateHash: ["final_state_hash", hash],
  submitterAddress: ["submitter_address", addr],
  blockNumber: ["block_number", u64],
  txHash: ["tx_hash", hash],
  logIndex: ["log_index", u64],
  snapshot: ["snapshot", toCommitmentSnapshot],
  createdAt: ["created_at", date],
  updatedAt: ["updated_at", date],
});

/** Every mapper, for the schema-drift test. */
export const MAPPERS = [
  toPagination,
  toNodeInfo,
  toApplication,
  toEpoch,
  toNotice,
  toVoucher,
  toDelegateCallVoucher,
  toOutput,
  toEvmAdvance,
  toInput,
  toTournamentInnerResult,
  toTournamentBondRecovery,
  toTournamentSnapshot,
  toTournamentCreationEvent,
  toTournament,
  toMatchBisectionSnapshot,
  toMatchSealedSnapshot,
  toMatchSnapshot,
  toLeafMatchSeal,
  toMatch,
  toCommitmentSnapshot,
  toCommitment,
];

// -------------------------------------------------------------
// result wrappers
// -------------------------------------------------------------
const single = (mapper) => (raw, method) => {
  if (!raw || typeof raw !== "object" || raw.data == null)
    throw new NodeShapeError(method, "result.data");
  return mapper(raw.data, method);
};

const list = (mapper) => (raw, method) => {
  if (!raw || !Array.isArray(raw.data))
    throw new NodeShapeError(method, "result.data", "not an array");
  return {
    data: raw.data.map((r) => mapper(r, method)),
    pagination: toPagination(raw.pagination, method) ?? {
      totalCount: raw.data.length,
      limit: null,
      offset: null,
    },
  };
};

const scalarU64 = (raw, method) => {
  if (!raw || typeof raw !== "object" || raw.data == null)
    throw new NodeShapeError(method, "result.data");
  try {
    return u64(raw.data);
  } catch (e) {
    throw new NodeShapeError(method, "result.data", e.message);
  }
};

// -------------------------------------------------------------
// param encoding (JS -> wire)
// -------------------------------------------------------------
// Index-like values travel as hex strings; limit/offset as JSON integers;
// booleans and addresses as they are. Undefined entries are dropped.
const hexParam = (v) => (v === undefined ? undefined : numberToHex(BigInt(v)));
const intParam = (v) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad integer param ${v}`);
  return n;
};
const listParam = (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
const addrParam = (v) => (v === undefined ? undefined : getAddress(v));

const clean = (o) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const paging = (p) => ({
  limit: intParam(p.limit),
  offset: intParam(p.offset),
  descending: p.descending,
});

/**
 * Call descriptors: { method, params, map }. `client.<name>(args)` runs one;
 * `client.batch([...])` runs several in one HTTP round trip.
 */
export const calls = {
  getNodeInfo: () => ({ method: "cartesi_getNodeInfo", params: [], map: single(toNodeInfo) }),

  getApplication: ({ application }) => ({
    method: "cartesi_getApplication",
    params: { application },
    map: single(toApplication),
  }),

  getLastAcceptedEpochIndex: ({ application }) => ({
    method: "cartesi_getLastAcceptedEpochIndex",
    params: { application },
    map: scalarU64,
  }),

  listEpochs: (p) => ({
    method: "cartesi_listEpochs",
    params: clean({
      application: p.application,
      status: listParam(p.status),
      from: hexParam(p.from),
      to: hexParam(p.to),
      ...paging(p),
    }),
    map: list(toEpoch),
  }),

  listOutputs: (p) => ({
    method: "cartesi_listOutputs",
    params: clean({
      application: p.application,
      epoch_index: hexParam(p.epochIndex),
      input_index: hexParam(p.inputIndex),
      output_type: listParam(p.outputType),
      voucher_address: addrParam(p.voucherAddress),
      executed: p.executed,
      from: hexParam(p.from),
      to: hexParam(p.to),
      ...paging(p),
    }),
    map: list(toOutput),
  }),

  getInput: ({ application, inputIndex }) => ({
    method: "cartesi_getInput",
    params: { application, input_index: hexParam(inputIndex) },
    map: single(toInput),
  }),

  listTournaments: (p) => ({
    method: "cartesi_listTournaments",
    params: clean({
      application: p.application,
      epoch_index: hexParam(p.epochIndex),
      level: hexParam(p.level),
      parent_tournament_address: addrParam(p.parentTournamentAddress),
      parent_match_id_hash: p.parentMatchIdHash,
      ...paging(p),
    }),
    map: list(toTournament),
  }),

  listCommitments: (p) => ({
    method: "cartesi_listCommitments",
    params: clean({
      application: p.application,
      epoch_index: hexParam(p.epochIndex),
      tournament_address: addrParam(p.tournamentAddress),
      ...paging(p),
    }),
    map: list(toCommitment),
  }),

  listMatches: (p) => ({
    method: "cartesi_listMatches",
    params: clean({
      application: p.application,
      epoch_index: hexParam(p.epochIndex),
      tournament_address: addrParam(p.tournamentAddress),
      ...paging(p),
    }),
    map: list(toMatch),
  }),
};

// -------------------------------------------------------------
// transport
// -------------------------------------------------------------
export const MAX_BATCH = 100; // node limit; larger batches get -32040

/**
 * @param {object} opts
 * @param {string} opts.url       full endpoint, e.g. `${NODE_URL}/rpc`
 * @param {Function} [opts.fetch] injectable for tests
 */
export function createNodeClient({ url, fetch: fetchImpl } = {}) {
  if (!url) throw new Error("createNodeClient: url is required");
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!doFetch) throw new Error("createNodeClient: no fetch available");
  let nextId = 1;

  async function post(body, label) {
    let res;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new NodeTransportError(label, e?.message || "network error", e);
    }
    if (!res.ok)
      throw new NodeTransportError(label, `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (e) {
      throw new NodeTransportError(label, "non-JSON response", e);
    }
  }

  // Turn one JSON-RPC envelope into a value or a thrown error.
  function settle(env, desc) {
    if (!env || typeof env !== "object")
      throw new NodeTransportError(desc.method, "malformed envelope");
    if (env.error) {
      const { code, message } = env.error;
      throw new NodeRpcError(desc.method, code, message ?? "error");
    }
    if (!("result" in env))
      throw new NodeTransportError(desc.method, "envelope without result");
    return desc.map ? desc.map(env.result, desc.method) : env.result;
  }

  async function run(desc) {
    const id = nextId++;
    const env = await post(
      { jsonrpc: "2.0", id, method: desc.method, params: desc.params },
      desc.method,
    );
    return settle(env, desc);
  }

  /**
   * Run several descriptors in one HTTP request. Resolves to an array of
   * { ok, value } | { ok, error } in request order; never rejects on a
   * per-entry error, only on transport failure.
   */
  async function batch(descs) {
    if (!descs.length) return [];
    if (descs.length > MAX_BATCH)
      throw new Error(`batch of ${descs.length} exceeds ${MAX_BATCH}`);
    const ids = descs.map(() => nextId++);
    const body = descs.map((d, i) => ({
      jsonrpc: "2.0",
      id: ids[i],
      method: d.method,
      params: d.params,
    }));
    const label = `batch[${descs.map((d) => d.method).join(",")}]`;
    const envs = await post(body, label);
    if (!Array.isArray(envs)) {
      // A whole-batch rejection (e.g. -31004) comes back as one envelope.
      const err = settleToError(envs, { method: label });
      return descs.map(() => ({ ok: false, error: err }));
    }
    const byId = new Map(envs.map((e) => [e?.id, e]));
    return descs.map((d, i) => {
      const env = byId.get(ids[i]);
      if (!env)
        return {
          ok: false,
          error: new NodeTransportError(d.method, "missing batch entry"),
        };
      try {
        return { ok: true, value: settle(env, d) };
      } catch (error) {
        return { ok: false, error };
      }
    });
  }

  function settleToError(env, desc) {
    try {
      settle(env, desc);
      return new NodeTransportError(desc.method, "unexpected batch reply");
    } catch (e) {
      return e;
    }
  }

  const client = { url, run, batch, calls };
  for (const [name, make] of Object.entries(calls))
    client[name] = (args) => run(make(args ?? {}));
  return client;
}

// -------------------------------------------------------------
// paging helpers
// -------------------------------------------------------------

/**
 * Fetch up to `cap` outputs matching `filter`, newest first unless the filter
 * says otherwise. The first page reveals total_count; the remaining pages go
 * out as one batch per MAX_BATCH. Rows are de-duplicated by index because an
 * output can land between two pages and shift the offsets.
 *
 * Returns { data, totalCount, truncated }.
 */
export async function listAllOutputs(
  client,
  { cap = 2000, pageSize = 100, ...filter },
) {
  if (!(cap > 0)) throw new Error("listAllOutputs: cap must be positive");
  const first = await client.listOutputs({ ...filter, limit: pageSize, offset: 0 });
  const totalCount = first.pagination.totalCount;
  const want = Math.min(totalCount, cap);

  const seen = new Set();
  const data = [];
  const take = (rows) => {
    for (const r of rows) {
      const k = r.index.toString();
      if (seen.has(k) || data.length >= want) continue;
      seen.add(k);
      data.push(r);
    }
  };
  take(first.data);

  const descs = [];
  for (let offset = pageSize; offset < want; offset += pageSize) {
    descs.push(
      calls.listOutputs({
        ...filter,
        limit: Math.min(pageSize, want - offset),
        offset,
      }),
    );
  }
  for (let i = 0; i < descs.length; i += MAX_BATCH) {
    const results = await client.batch(descs.slice(i, i + MAX_BATCH));
    for (const r of results) {
      if (!r.ok) throw r.error;
      take(r.value.data);
    }
  }
  return { data, totalCount, truncated: totalCount > cap };
}
