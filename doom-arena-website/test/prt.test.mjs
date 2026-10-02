// Run with: npm test   (node's built-in runner, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toFunctionSignature } from "viem";

import {
  EPOCH_STATUS,
  TERMINAL_EPOCH_STATUS,
  NON_TERMINAL_PAST_OPEN,
  TOURNAMENT_STANDING,
  MATCH_PHASE,
  COMMITMENT_SIDE,
  TIMEOUT_OUTCOME,
  DELETION_REASON,
  epochStatus,
  isSettled,
  standingOf,
  isMatchActive,
  buildTournamentTree,
  fetchPrtState,
  formatBlocks,
  describeStaging,
  describeDispute,
  describeTree,
  daveConsensusAbi,
} from "../src/prt.js";

const css = readFileSync(new URL("../src/arena.css", import.meta.url), "utf8");
const discover = JSON.parse(
  readFileSync(new URL("./fixtures/jsonrpc-discover.json", import.meta.url), "utf8"),
);
const ENUM = (name) => discover.components.schemas[name].enum;

// -------------------------------------------------------------
// 1. status maps — pinned to the node's enums
// -------------------------------------------------------------
test("every node EpochStatus maps to a label and a real CSS class", () => {
  for (const s of ENUM("EpochStatus")) {
    const got = epochStatus({ status: s });
    assert.ok(got.label && got.label !== "—", `${s} has no label`);
    assert.match(
      css,
      new RegExp(`\\.status-${got.tone}\\s*\\{`),
      `${s} -> tone "${got.tone}" has no .status-${got.tone} rule in arena.css`,
    );
  }
});

test("EPOCH_STATUS covers exactly the node's enum", () => {
  assert.deepEqual(Object.keys(EPOCH_STATUS).sort(), [...ENUM("EpochStatus")].sort());
});

test("terminal + non-terminal-past-open + OPEN partition the enum", () => {
  const all = [...TERMINAL_EPOCH_STATUS, ...NON_TERMINAL_PAST_OPEN, "OPEN"].sort();
  assert.deepEqual(all, [...ENUM("EpochStatus")].sort());
  assert.ok(isSettled({ status: "CLAIM_ACCEPTED" }));
  assert.ok(!isSettled({ status: "CLAIM_STAGED" }));
  assert.ok(!isSettled(null));
});

test("settled states are distinguishable", () => {
  assert.equal(epochStatus({ status: "CLAIM_ACCEPTED" }).tone, "ok");
  assert.equal(epochStatus({ status: "CLAIM_REJECTED" }).tone, "bad");
  assert.equal(epochStatus({ status: "CLAIM_FORECLOSED" }).tone, "bad");
  assert.notEqual(
    epochStatus({ status: "CLAIM_REJECTED" }).label,
    epochStatus({ status: "CLAIM_COMPUTED" }).label,
  );
});

test("unknown / missing status stays legible", () => {
  assert.equal(epochStatus({ status: "SOME_NEW_STATE" }).label, "SOME NEW STATE");
  assert.equal(epochStatus({ status: "SOME_NEW_STATE" }).tone, "pending");
  assert.equal(epochStatus({}).label, "—");
  assert.equal(epochStatus(null).label, "—");
});

test("TOURNAMENT_STANDING covers exactly TournamentStandingState, each with a real CSS class", () => {
  assert.deepEqual(
    Object.keys(TOURNAMENT_STANDING).sort(),
    [...ENUM("TournamentStandingState")].sort(),
  );
  for (const k of ENUM("TournamentStandingState")) {
    const s = standingOf(k);
    assert.equal(s.key, k);
    assert.ok(s.label);
    assert.match(css, new RegExp(`\\.status-${s.tone}\\s*\\{`));
  }
  assert.equal(standingOf("SOMETHING_ELSE").label, "UNKNOWN");
  assert.equal(standingOf(null).label, "UNKNOWN");
  assert.equal(standingOf("matches_active").key, "MATCHES_ACTIVE"); // case-tolerant
});

test("match enums match the node", () => {
  assert.deepEqual(MATCH_PHASE, ENUM("MatchPhase"));
  assert.deepEqual(COMMITMENT_SIDE, ENUM("CommitmentSide"));
  assert.deepEqual(Object.keys(TIMEOUT_OUTCOME).sort(), [...ENUM("MatchTimeoutOutcome")].sort());
  assert.deepEqual(Object.keys(DELETION_REASON).sort(), [...ENUM("MatchDeletionReason")].sort());
});

test("match liveness", () => {
  assert.ok(isMatchActive({ deletionReason: "NOT_DELETED" }));
  assert.ok(isMatchActive({}));
  assert.ok(!isMatchActive({ deletionReason: "TIMEOUT" }));
});

// -------------------------------------------------------------
// 2. ABI shape vs the official Dave artifacts
// -------------------------------------------------------------
// Signatures extracted from cartesi-rollups-prt-3.0.0-alpha.5-contract-artifacts
// (github.com/cartesi/dave releases). Inputs AND outputs are compared, since a
// wrong output tuple decodes to garbage rather than reverting.
const OFFICIAL_V5_CONSENSUS = {
  getCurrentSealedEpoch:
    "getCurrentSealedEpoch() view returns (uint256,uint256,uint256,address,bool,uint256,bytes32,bytes32)",
  canStageTournamentResult:
    "canStageTournamentResult() view returns (bool,bool,bool,uint256,bytes32,bytes32)",
  canAcceptStagedTournamentResult:
    "canAcceptStagedTournamentResult() view returns (bool,bool,bool,uint256,bytes32,bytes32)",
  getClaimStagingPeriod: "getClaimStagingPeriod() view returns (uint256)",
  getNumberOfSentries: "getNumberOfSentries() view returns (uint256)",
  getSentryClaimCount: "getSentryClaimCount(uint256,bytes32) view returns (uint256)",
  hasSentryClaimedInEpoch: "hasSentryClaimedInEpoch(uint256,uint256) view returns (bool)",
};

const fullSig = (item) => {
  const sig = toFunctionSignature(item); // name(inputs)
  const outs = (item.outputs ?? []).map(typeOf).join(",");
  return `${sig} view returns (${outs})`;
};
const typeOf = (p) =>
  p.type.startsWith("tuple")
    ? `(${p.components.map(typeOf).join(",")})${p.type.slice(5)}`
    : p.type;

test("alpha.5 IDaveConsensus ABI matches the official artifact", () => {
  const got = Object.fromEntries(
    daveConsensusAbi.filter((e) => e.type === "function").map((e) => [e.name, fullSig(e)]),
  );
  assert.deepEqual(got, OFFICIAL_V5_CONSENSUS);
});

// -------------------------------------------------------------
// 3. tree building
// -------------------------------------------------------------
const T = (address, level, parent = null, snapshot = undefined) => ({
  address,
  level: BigInt(level),
  parentTournamentAddress: parent,
  snapshot,
});

test("flat list becomes a depth-ordered tree", () => {
  const { roots, order } = buildTournamentTree([
    T("0xCC", 2, "0xBB"),
    T("0xAA", 0),
    T("0xBB", 1, "0xAA"),
  ]);
  assert.equal(roots.length, 1);
  assert.deepEqual(
    order.map((o) => [o.node.address, o.depth]),
    [["0xAA", 0], ["0xBB", 1], ["0xCC", 2]],
  );
});

test("sibling inner tournaments both appear", () => {
  const { order } = buildTournamentTree([T("0xAA", 0), T("0xB1", 1, "0xAA"), T("0xB2", 1, "0xAA")]);
  assert.deepEqual(order.map((o) => o.depth), [0, 1, 1]);
});

test("parent linking is case-insensitive", () => {
  const { roots } = buildTournamentTree([T("0xAa", 0), T("0xBB", 1, "0xaA")]);
  assert.equal(roots.length, 1);
});

test("an orphan is surfaced, not dropped", () => {
  const { order } = buildTournamentTree([T("0xAA", 0), T("0xZZ", 1, "0xMISSING")]);
  assert.equal(order.length, 2);
});

test("a parent cycle cannot hang the walk", () => {
  const { order } = buildTournamentTree([
    { address: "0xAA", level: 0n, parentTournamentAddress: "0xBB" },
    { address: "0xBB", level: 1n, parentTournamentAddress: "0xAA" },
  ]);
  assert.equal(order.length, 2);
});

test("self-parent does not recurse", () => {
  const { order } = buildTournamentTree([T("0xAA", 0, "0xAA")]);
  assert.equal(order.length, 1);
});

// -------------------------------------------------------------
// 4. fetchPrtState — stubbed node + chain
// -------------------------------------------------------------
const page = (data, total = data.length) => ({ data, pagination: { totalCount: total } });

// Snapshot builders shaped like nodeRpc.js output.
const AS_OF = 990n;
const tSnap = (standing, over = {}) => ({
  asOfBlock: AS_OF,
  standing,
  acceptsJoins: false,
  candidate: null,
  winnerCommitment: null,
  finalStateHash: null,
  parentCommitment: null,
  finishedAtBlock: 0n,
  winnerExpiresAt: 0n,
  innerResult: null,
  bondRecovery: { disposition: "TOURNAMENT_RUNNING", claimer: null, payment: null },
  ...over,
});
const mSnap = (phase, bisection = null, over = {}) => ({
  asOfBlock: AS_OF,
  phase,
  bisection,
  sealed: null,
  timeoutOutcome: "NONE",
  deferredCharge: 0n,
  ...over,
});
const cSnap = (running, deadline, claimer = "0xC1A1") => ({
  asOfBlock: AS_OF,
  claimer,
  clockRunning: running,
  clockDeadline: deadline,
  clockAllowance: 100n,
});
const commitment = (tournamentAddress, hash, snapshot) => ({
  tournamentAddress,
  commitment: hash,
  snapshot,
});

function stubNode({ tournaments = [], commitments = [], matches = [], fail = false } = {}) {
  const calls = [];
  const rec = (name, v) => async (p) => {
    calls.push([name, p]);
    if (fail) throw new Error("node down");
    return v;
  };
  return {
    calls,
    listTournaments: rec("listTournaments", page(tournaments)),
    listCommitments: rec("listCommitments", page(commitments)),
    listMatches: rec("listMatches", page(matches)),
  };
}

// reads: { "<address>|<fn>": value | Error }
function stubChain(reads = {}, blockNumber = 1000n) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => {
      if (blockNumber instanceof Error) throw blockNumber;
      return blockNumber;
    },
    readContract: async ({ address, functionName }) => {
      calls.push(`${address}|${functionName}`);
      const v = reads[`${address}|${functionName}`] ?? reads[`*|${functionName}`];
      if (v === undefined) throw new Error(`revert: no ${functionName} on ${address}`);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const base = {
  application: "app",
  consensusAddress: "0xDACE",
  epoch: { index: 7n, status: "CLAIM_SUBMITTED", tournamentAddress: "0xAA" },
};

test("no dispute: single commitment, no matches", async () => {
  const node = stubNode({
    tournaments: [T("0xAA", 0, null, tSnap("AWAITING_CLOSURE"))],
    commitments: [commitment("0xAA", "0xC1", cSnap(false, 0n))],
  });
  const out = await fetchPrtState({ ...base, nodeClient: node, l1Client: stubChain() });
  assert.equal(out.disputed, false);
  assert.equal(out.epochIndex, 7n);
  assert.equal(out.root.standing.key, "AWAITING_CLOSURE");
  assert.equal(out.snapshotOk, true);
  assert.equal(out.asOfBlock, AS_OF);
  assert.equal(out.currentBlock, 1000n);
  // node calls are scoped to the epoch
  for (const [, p] of node.calls) assert.equal(p.epochIndex, 7n);
});

test("dispute: two commitments and a live bisecting match with clocks from snapshots", async () => {
  const m = {
    tournamentAddress: "0xAA",
    idHash: "0xM1",
    commitmentOne: "0xC1",
    commitmentTwo: "0xC2",
    deletionReason: "NOT_DELETED",
    snapshot: mSnap("BISECTING", { currentHeight: 41n, responder: "TWO" }),
  };
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE"))],
      commitments: [
        commitment("0xAA", "0xC1", cSnap(false, 0n)),
        commitment("0xAA", "0xC2", cSnap(true, 1200n)),
      ],
      matches: [m],
    }),
    l1Client: stubChain({}, 1000n),
  });
  assert.equal(out.disputed, true);
  assert.equal(out.commitmentCount, 2);
  assert.equal(out.matchCount, 1);
  assert.equal(out.activeMatchCount, 1);
  assert.equal(out.root.standing.key, "MATCHES_ACTIVE");
  const [mm] = out.matches;
  assert.equal(mm.phase, "BISECTING");
  assert.equal(mm.currentHeight, 41n);
  assert.equal(mm.responder, "TWO");
  assert.equal(mm.clocks[1].running, true);
  assert.equal(mm.blocksToTimeout, 200n); // 1200 - 1000, TWO is on the clock
});

test("a match already past its deadline clamps to 0, never negative", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE"))],
      commitments: [
        commitment("0xAA", "0xC1", cSnap(true, 900n)),
        commitment("0xAA", "0xC2", cSnap(false, 0n)),
      ],
      matches: [
        {
          tournamentAddress: "0xAA", idHash: "0xM1", commitmentOne: "0xC1", commitmentTwo: "0xC2",
          deletionReason: "NOT_DELETED",
          snapshot: mSnap("BISECTING", { currentHeight: 3n, responder: "ONE" }, { timeoutOutcome: "TWO_WINS" }),
        },
      ],
    }),
    l1Client: stubChain({}, 1000n),
  });
  assert.equal(out.matches[0].blocksToTimeout, 0n);
  assert.equal(out.matches[0].timeoutOutcome, "TWO_WINS");
});

test("commitment clocks are matched per tournament, case-insensitively", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE")), T("0xBB", 1, "0xAA", tSnap("MATCHES_ACTIVE"))],
      commitments: [
        commitment("0xaa", "0xc1", cSnap(true, 1500n)), // root clock
        commitment("0xBB", "0xC1", cSnap(true, 1100n)), // same commitment, inner tournament
        commitment("0xBB", "0xC2", cSnap(false, 0n)),
      ],
      matches: [
        {
          tournamentAddress: "0xBB", idHash: "0xM2", commitmentOne: "0xC1", commitmentTwo: "0xC2",
          deletionReason: "NOT_DELETED", snapshot: mSnap("BISECTING", { currentHeight: 5n, responder: "ONE" }),
        },
      ],
    }),
    l1Client: stubChain({}, 1000n),
  });
  assert.equal(out.matches[0].blocksToTimeout, 100n); // inner clock, not the root's
});

test("nested inner tournaments carry their own standing", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [
        T("0xAA", 0, null, tSnap("MATCHES_ACTIVE")),
        T("0xBB", 1, "0xAA", tSnap("INNER_WINNER", { winnerExpiresAt: 1400n })),
      ],
      commitments: [commitment("0xAA", "0xC1", cSnap(false, 0n)), commitment("0xAA", "0xC2", cSnap(false, 0n))],
    }),
    l1Client: stubChain(),
  });
  assert.equal(out.order.length, 2);
  assert.equal(out.order[1].node.standing.key, "INNER_WINNER");
  assert.equal(out.order[1].depth, 1);
});

test("ROOT_FAILED surfaces as a bad standing", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_REJECTED" },
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_FAILED"))] }),
    l1Client: stubChain(),
  });
  assert.equal(out.root.standing.tone, "bad");
  assert.match(out.root.standing.label, /NO WINNER/);
});

test("CLAIM_STAGED produces a block countdown from node data + chain block", async () => {
  const chain = stubChain(
    { "0xDACE|canAcceptStagedTournamentResult": [true, true, false, 7n, "0x00", "0x00"] },
    1000n,
  );
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 980n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: chain,
  });
  assert.equal(out.staging.blocksLeft, 80n);
  assert.equal(out.staging.isOver, false);
  assert.equal(out.staging.sentriesAgree, true);
  assert.equal(out.staging.periodBlocks, 100n);
  assert.equal(out.staging.sentries, null); // getNumberOfSentries reverted -> unknown
  // the only eth_calls the panel still makes, and only while staged
  assert.deepEqual(chain.calls.sort(), ["0xDACE|canAcceptStagedTournamentResult", "0xDACE|getNumberOfSentries"]);
});

test("zero sentries: the fast-path flag is false but that is NOT dissent", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 980n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: stubChain({
      // exactly what Dave alpha.5 returns with no sentries configured
      "0xDACE|canAcceptStagedTournamentResult": [true, false, false, 7n, "0x00", "0x00"],
      "0xDACE|getNumberOfSentries": 0n,
    }),
  });
  assert.equal(out.staging.sentriesAgree, false);
  assert.equal(out.staging.sentries, null);
  const d = describeStaging(out);
  assert.equal(d.tone, "dim");
  assert.equal(d.text, "accepts in 80\u00a0blk\u00a0(~3m)");
});

test("all sentries agree: fast path, acceptable before the period ends", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 980n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: stubChain({
      "0xDACE|canAcceptStagedTournamentResult": [true, true, false, 7n, "0x11", "0x00"],
      "0xDACE|getNumberOfSentries": 2n,
      "0xDACE|getSentryClaimCount": 2n,
      "0xDACE|hasSentryClaimedInEpoch": true,
    }),
  });
  assert.deepEqual(out.staging.sentries, { total: 2, agreeing: 2, claimed: 2, dissent: false });
  const d = describeStaging(out);
  assert.equal(d.tone, "ok");
  assert.match(d.text, /all 2 sentries agree/);
});

test("CLAIM_STAGED without any chain still counts down from the node's block", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 950n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: null,
  });
  assert.equal(out.currentBlock, AS_OF); // 990
  assert.equal(out.staging.blocksLeft, 60n);
  assert.equal(out.staging.sentriesAgree, null); // not knowable without the chain
  assert.equal(out.staging.isOver, false);
});

test("a dissenting sentry is derived from the claim counters", async () => {
  const chain = stubChain({
    "0xDACE|canAcceptStagedTournamentResult": [true, false, false, 7n, "0x11", "0x00"],
    "0xDACE|getNumberOfSentries": 2n,
    "0xDACE|getSentryClaimCount": 1n, // one claimed the staged hash...
    "0xDACE|hasSentryClaimedInEpoch": true, // ...but both claimed something
  });
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 980n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: chain,
  });
  assert.deepEqual(out.staging.sentries, { total: 2, agreeing: 1, claimed: 2, dissent: true });
  const d = describeStaging(out);
  assert.equal(d.tone, "bad");
  assert.match(d.text, /1\/2 claimed the staged result/);
  assert.match(d.text, /accepts in 80/); // the period still has to run
  assert.equal(chain.calls.filter((c) => /hasSentryClaimedInEpoch/.test(c)).length, 2);
});

test("a sentry that has not claimed yet is not dissent", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 980n },
    claimStagingPeriod: 100n,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: {
      getBlockNumber: async () => 1000n,
      readContract: async ({ functionName, args }) =>
        ({
          canAcceptStagedTournamentResult: [true, false, false, 7n, "0x11", "0x00"],
          getNumberOfSentries: 2n,
          getSentryClaimCount: 1n,
          hasSentryClaimedInEpoch: args[1] === 1n, // only sentry #1 claimed
        })[functionName],
    },
  });
  assert.deepEqual(out.staging.sentries, { total: 2, agreeing: 1, claimed: 1, dissent: false });
  assert.equal(describeStaging(out).tone, "dim");
});

test("staging row stays hidden when nothing is knowable", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: null },
    claimStagingPeriod: null,
    nodeClient: stubNode({ tournaments: [] }),
    l1Client: stubChain({}, new Error("rpc down")),
  });
  assert.equal(out.staging, null);
});

test("not staged: no consensus eth_call at all", async () => {
  const chain = stubChain();
  await fetchPrtState({
    ...base,
    nodeClient: stubNode({ tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE"))] }),
    l1Client: chain,
  });
  assert.deepEqual(chain.calls, []);
});

test("a node without snapshots (pre-#798) flags snapshotOk=false and keeps the structure", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0), T("0xBB", 1, "0xAA")],
      commitments: [commitment("0xAA", "0xC1", null), commitment("0xAA", "0xC2", null)],
      matches: [{ tournamentAddress: "0xAA", idHash: "0xM1", commitmentOne: "0xC1", commitmentTwo: "0xC2", deletionReason: "NOT_DELETED" }],
    }),
    l1Client: stubChain(),
  });
  assert.equal(out.snapshotOk, false);
  assert.equal(out.asOfBlock, null);
  assert.equal(out.disputed, true);
  assert.equal(out.root.standing, null);
  assert.equal(out.matches[0].phase, null);
  assert.equal(out.matches[0].blocksToTimeout, null);
  const notes = describeTree(out).filter((r) => r.kind === "note");
  assert.equal(notes.length, 1);
  assert.match(notes[0].label, /unavailable/);
});

test("chain unreachable: node data and node block carry the panel", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE"))],
      commitments: [commitment("0xAA", "0xC1", cSnap(true, 1050n)), commitment("0xAA", "0xC2", cSnap(false, 0n))],
      matches: [{
        tournamentAddress: "0xAA", idHash: "0xM1", commitmentOne: "0xC1", commitmentTwo: "0xC2",
        deletionReason: "NOT_DELETED", snapshot: mSnap("BISECTING", { currentHeight: 2n, responder: "ONE" }),
      }],
    }),
    l1Client: stubChain({}, new Error("rpc down")),
  });
  assert.equal(out.currentBlock, AS_OF);
  assert.equal(out.matches[0].blocksToTimeout, 60n); // 1050 - 990
  assert.equal(out.root.standing.key, "MATCHES_ACTIVE");
});

test("node RPC failure degrades to an empty view rather than throwing", async () => {
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({ fail: true }),
    l1Client: stubChain(),
  });
  assert.equal(out.disputed, false);
  assert.equal(out.tournaments.length, 0);
  assert.equal(out.snapshotOk, null);
  // the epoch's own tournament address still gives the root a name
  assert.equal(out.root.address, "0xAA");
});

test("no epoch / no node client: inert view model", async () => {
  const a = await fetchPrtState({ ...base, epoch: null, nodeClient: stubNode() });
  const b = await fetchPrtState({ ...base, nodeClient: null });
  for (const out of [a, b]) {
    assert.equal(out.disputed, false);
    assert.equal(out.root, null);
    assert.equal(out.staging, null);
  }
});

test("epoch without a tournament yet", async () => {
  const out = await fetchPrtState({
    ...base,
    epoch: { index: 8n, status: "CLAIM_COMPUTED", tournamentAddress: null },
    nodeClient: stubNode(),
    l1Client: stubChain(),
  });
  assert.equal(out.root, null);
  assert.equal(out.disputed, false);
  assert.equal(describeDispute(out), null);
});

test("counts come from pagination.totalCount even when rows are capped", async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    tournamentAddress: "0xAA", idHash: `0xM${i}`, commitmentOne: "0xC1", commitmentTwo: "0xC2",
    deletionReason: i < 3 ? "NOT_DELETED" : "STEP", snapshot: mSnap("UNINITIALIZED"),
  }));
  const node = {
    listTournaments: async () => page([T("0xAA", 0, null, tSnap("MATCHES_ACTIVE"))]),
    listCommitments: async () => page([], 120),
    listMatches: async () => page(many, 130),
  };
  const out = await fetchPrtState({ ...base, nodeClient: node, l1Client: stubChain() });
  assert.equal(out.commitmentCount, 120);
  assert.equal(out.matchCount, 130);
  assert.equal(out.activeMatchCount, 3);
});

// -------------------------------------------------------------
// 5. view helpers (pure — no DOM needed)
// -------------------------------------------------------------
test("formatBlocks pairs a block delta with wall time", () => {
  assert.equal(formatBlocks(null), "—");
  assert.equal(formatBlocks(0n), "now");
  assert.equal(formatBlocks(-5n), "now"); // never render a negative countdown
  assert.equal(formatBlocks(10n), "10 blk (~20s)");
  assert.equal(formatBlocks(60n), "60 blk (~2m)");
  assert.equal(formatBlocks(3600n), "3600 blk (~2h)");
  assert.equal(formatBlocks(10n, 12), "10 blk (~2m)"); // other chains
});

test("describeStaging: countdown, elapsed, and dissent", () => {
  assert.equal(describeStaging(null), null);
  assert.equal(describeStaging({ staging: null }), null);
  assert.deepEqual(
    describeStaging({ staging: { isOver: false, blocksLeft: 40n, sentriesAgree: null } }),
    { text: "accepts in 40 blk (~1m)", tone: "dim" },
  );
  assert.equal(
    describeStaging({ staging: { isOver: true, sentriesAgree: false } }).text,
    "staging period over — awaiting acceptance",
  );
  // the fast-path flag alone (false) is just "wait": no sentries, or none claimed yet
  assert.equal(describeStaging({ staging: { isOver: false, blocksLeft: 40n, sentriesAgree: false } }).tone, "dim");
  // derived dissent outranks the clock, but still shows it
  const d = describeStaging({
    staging: { isOver: false, blocksLeft: 40n, sentriesAgree: false, sentries: { total: 2, agreeing: 1, claimed: 2, dissent: true } },
  });
  assert.equal(d.tone, "bad");
  assert.match(d.text, /sentry disagrees.*accepts in 40/);
  // fast path
  assert.equal(describeStaging({ staging: { isOver: false, blocksLeft: 40n, sentriesAgree: true, sentries: { total: 1 } } }).tone, "ok");
});

test("describeDispute summarises counts (the row head names the epoch)", () => {
  assert.equal(describeDispute({ disputed: false }), null);
  const d = describeDispute({
    disputed: true,
    epochIndex: 7n,
    commitmentCount: 2,
    activeMatchCount: 1,
    matchCount: 3,
    tournaments: [1, 2],
    root: { standing: { label: "DISPUTE ACTIVE", tone: "bad" } },
  });
  assert.equal(d.standing.label, "DISPUTE ACTIVE");
  assert.equal(d.meta, "2 commitments · 1/3 matches active · 2 tournaments");
});

test("describeDispute falls back when the node gave no standing", () => {
  const d = describeDispute({
    disputed: true, commitmentCount: 2, activeMatchCount: 0,
    matchCount: 0, tournaments: [1], root: {},
  });
  assert.equal(d.standing.label, "DISPUTE");
  assert.equal(d.standing.tone, "bad");
  assert.ok(!d.meta.includes("tournaments")); // single tournament -> omitted
});

test("describeTree interleaves tournaments with their matches", () => {
  const rows = describeTree({
    order: [
      { node: { address: "0xAA", level: 0n, standing: standingOf("MATCHES_ACTIVE") }, depth: 0 },
      { node: { address: "0xBB", level: 1n, standing: standingOf("INNER_WINNER") }, depth: 1 },
    ],
    matches: [
      {
        tournamentAddress: "0xAA", idHash: "0xM1", deletionReason: "NOT_DELETED",
        phase: "BISECTING", currentHeight: 41n, responder: "TWO", blocksToTimeout: 200n, timeoutOutcome: "NONE",
      },
      { tournamentAddress: "0xBB", idHash: "0xM2", deletionReason: "TIMEOUT" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.depth]), [
    ["tournament", 0], ["match", 1], ["tournament", 1], ["match", 2],
  ]);
  assert.equal(rows[0].label, "root");
  assert.equal(rows[1].label, "BISECTING · h=41 · TWO on clock · 200 blk (~7m)");
  assert.equal(rows[1].active, true);
  assert.equal(rows[2].label, "L1");
  assert.equal(rows[3].label, "timed out"); // resolved match reads as history
  assert.equal(rows[3].active, false);
});

test("describeTree shows the timeout classifier when it says something", () => {
  const rows = describeTree({
    order: [{ node: { address: "0xAA", level: 0n }, depth: 0 }],
    matches: [{
      tournamentAddress: "0xAA", idHash: "0xM1", deletionReason: "NOT_DELETED",
      phase: "BISECTING", responder: "ONE", blocksToTimeout: 0n, timeoutOutcome: "TWO_WINS",
    }],
  });
  assert.equal(rows[1].label, "BISECTING · ONE on clock · now · TWO can win by timeout");
});

test("describeTree appends the as-of-block note only when the node lags the chain", () => {
  const model = (asOfBlock, currentBlock) => ({
    order: [{ node: { address: "0xAA", level: 0n }, depth: 0 }],
    matches: [],
    snapshotOk: true,
    asOfBlock,
    currentBlock,
  });
  assert.equal(describeTree(model(1000n, 1000n)).filter((r) => r.kind === "note").length, 0);
  assert.equal(describeTree(model(null, 1000n)).filter((r) => r.kind === "note").length, 0);
  const notes = describeTree(model(990n, 1000n)).filter((r) => r.kind === "note");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].label, "node view as of block 990 · 10 blk (~20s) behind");
});

test("describeTree matches tournaments case-insensitively", () => {
  const rows = describeTree({
    order: [{ node: { address: "0xAa", level: 0n }, depth: 0 }],
    matches: [{ tournamentAddress: "0xaA", idHash: "0xM1", deletionReason: "NOT_DELETED" }],
  });
  assert.equal(rows.length, 2);
});

test("describeTree tolerates a snapshot-less view model", () => {
  const rows = describeTree({
    order: [{ node: { address: "0xAA", level: 0n }, depth: 0 }],
    matches: [{ tournamentAddress: "0xAA", idHash: "0xM1", deletionReason: "NOT_DELETED" }],
  });
  assert.equal(rows[0].standing, null); // renderer falls back to "—"
  assert.equal(rows[1].label, "match"); // no phase available
});

test("describeTree on an empty/absent model", () => {
  assert.deepEqual(describeTree(null), []);
  assert.deepEqual(describeTree({}), []);
});

test("end to end: fetchPrtState output feeds the view helpers", async () => {
  const prt = await fetchPrtState({
    ...base,
    nodeClient: stubNode({
      tournaments: [T("0xAA", 0, null, tSnap("MATCHES_ACTIVE")), T("0xBB", 1, "0xAA", tSnap("MATCHES_ACTIVE"))],
      commitments: [commitment("0xAA", "0xC1", cSnap(false, 0n)), commitment("0xAA", "0xC2", cSnap(false, 0n))],
      matches: [{
        tournamentAddress: "0xAA", idHash: "0xM1", commitmentOne: "0xC1", commitmentTwo: "0xC2",
        deletionReason: "CHILD_TOURNAMENT", snapshot: mSnap("UNINITIALIZED"),
      }],
    }),
    l1Client: stubChain({}, 1000n),
  });
  const rows = describeTree(prt);
  assert.deepEqual(rows.map((r) => r.kind), ["tournament", "match", "tournament", "note"]);
  assert.equal(rows[1].label, "decided by inner tournament");
  assert.match(rows[3].label, /as of block 990/);
  assert.equal(describeDispute(prt).meta, "2 commitments · 0/1 matches active · 2 tournaments");
  assert.equal(describeStaging(prt), null);
});

test("tree labels stay ASCII-safe (no emoji tofu in the mono stack)", () => {
  const rows = describeTree({
    order: [{ node: { address: "0xAA", level: 0n }, depth: 0 }],
    matches: [{
      tournamentAddress: "0xAA", idHash: "0xM1", deletionReason: "NOT_DELETED",
      phase: "BISECTING", currentHeight: 12n, responder: "ONE", blocksToTimeout: 9n, timeoutOutcome: "ELIMINATE_BOTH",
    }],
    snapshotOk: false,
    asOfBlock: 1n,
    currentBlock: 2n,
  });
  const text = rows.map((r) => r.label).join(" ");
  assert.ok(
    !/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u.test(text),
    `label contains a glyph the mono stack may not have: ${text}`,
  );
});

// -------------------------------------------------------------
// 7. consensus state read from the contracts
// -------------------------------------------------------------
import {
  tournamentAbi,
  TOURNAMENT_STANDING_INDEX,
  standingFromIndex,
  fetchConsensusState,
  consensusPhase,
  isLivePhase,
  deriveLastAccepted,
  describeSettling,
  inputsOf,
} from "../src/prt.js";

const OFFICIAL_V5_TOURNAMENT = {
  tournamentStanding:
    "tournamentStanding() view returns ((uint8,bool,bool,bytes32,bytes32,bytes32,uint64,uint64))",
  getCommitmentJoinedCount: "getCommitmentJoinedCount() view returns (uint256)",
  getMatchCreatedCount: "getMatchCreatedCount() view returns (uint256)",
  getMatchDeletedCount: "getMatchDeletedCount() view returns (uint256)",
  getNewInnerTournamentCount: "getNewInnerTournamentCount() view returns (uint256)",
};

test("alpha.5 ITournament read ABI matches the official artifact", () => {
  const got = Object.fromEntries(
    tournamentAbi.filter((e) => e.type === "function").map((e) => [e.name, fullSig(e)]),
  );
  assert.deepEqual(got, OFFICIAL_V5_TOURNAMENT);
});

test("TOURNAMENT_STANDING_INDEX is the Solidity enum order and covers the node enum", () => {
  assert.deepEqual(
    [...TOURNAMENT_STANDING_INDEX].sort(),
    [...ENUM("TournamentStandingState")].sort(),
  );
  assert.equal(TOURNAMENT_STANDING_INDEX[0], "MATCHES_ACTIVE");
  assert.equal(TOURNAMENT_STANDING_INDEX[3], "ROOT_FAILED");
  assert.equal(standingFromIndex(3n).key, "ROOT_FAILED");
  assert.equal(standingFromIndex(3).tone, "bad");
  assert.equal(standingFromIndex(99).label, "UNKNOWN");
  assert.equal(standingFromIndex(null), null);
});

const CONS = "0xDACE";
const TADDR = "0xAA";
const H0 = "0x" + "0".repeat(64);
const HX = (n) => "0x" + n.toString(16).padStart(64, "0");
const ZERO_ADDR = "0x" + "0".repeat(40);
const sealedTuple = (epoch, t = TADDR, staged = false, stagingBlock = 0n, lo = 0n, hi = 4n) =>
  [BigInt(epoch), lo, hi, t, staged, stagingBlock, H0, H0];
const standingTuple = (idx, over = {}) => ({
  standing: idx,
  acceptsJoins: false,
  hasCandidate: false,
  candidate: H0,
  finalState: H0,
  parentCommitment: H0,
  finishedAt: 0n,
  winnerExpiresAt: 0n,
  ...over,
});
const canStageTuple = (finished, failed) => [finished, failed, false, 0n, H0, H0];

test("live Base Sepolia shape: node stuck at CLAIM_COMPUTED, tournament failed on-chain", async () => {
  const chain = stubChain(
    {
      [`${CONS}|getCurrentSealedEpoch`]: sealedTuple(0, TADDR, false, 0n, 0n, 0n),
      [`${CONS}|canStageTournamentResult`]: canStageTuple(true, true),
      [`${TADDR}|tournamentStanding`]: standingTuple(3, { finishedAt: 47018261n }),
      [`${TADDR}|getCommitmentJoinedCount`]: 0n,
      [`${TADDR}|getMatchCreatedCount`]: 0n,
      [`${TADDR}|getMatchDeletedCount`]: 0n,
      [`${TADDR}|getNewInnerTournamentCount`]: 0n,
    },
    47600984n,
  );
  const c = await fetchConsensusState({
    l1Client: chain,
    consensusAddress: CONS,
    nodeHasTournaments: false,
  });
  assert.equal(c.epochNumber, 0n);
  assert.equal(c.tournament, TADDR);
  assert.equal(c.staged, false);
  assert.equal(c.isFinished, true);
  assert.equal(c.isFailed, true);
  assert.equal(c.standing.key, "ROOT_FAILED");
  assert.equal(c.finishedAt, 47018261n);
  assert.equal(c.joined, 0n);
  assert.equal(c.currentBlock, 47600984n);
  assert.equal(c.phase.key, "FAILED");
  assert.equal(c.phase.tone, "bad");
  // the node had no rows, so the counters were read
  assert.ok(chain.calls.includes(`${TADDR}|getMatchCreatedCount`));
  // not staged: no canAccept read
  assert.ok(!chain.calls.includes(`${CONS}|canAcceptStagedTournamentResult`));

  const row = describeSettling({
    epoch: { index: 0n, status: "CLAIM_COMPUTED", inputIndexLowerBound: 0n, inputIndexUpperBound: 0n },
    consensus: c,
  });
  assert.equal(row.source, "chain");
  assert.equal(row.label, "TOURNAMENT FAILED");
  assert.equal(row.tone, "bad");
  assert.equal(row.epochIndex, 0n);
  assert.equal(row.inputs, 0);
  assert.match(row.detail, /cannot settle/);
  assert.equal(row.nodeNote, "node: CLAIM COMPUTED");
});

test("counters are skipped when the node already serves tournament rows; joined is not", async () => {
  const chain = stubChain({
    [`${CONS}|getCurrentSealedEpoch`]: sealedTuple(1),
    [`${CONS}|canStageTournamentResult`]: canStageTuple(false, false),
    [`${TADDR}|tournamentStanding`]: standingTuple(1),
    [`${TADDR}|getCommitmentJoinedCount`]: 1n,
  });
  const c = await fetchConsensusState({ l1Client: chain, consensusAddress: CONS });
  assert.ok(!chain.calls.some((x) => /getMatch|getNewInner/.test(x)));
  assert.equal(c.joined, 1n);
  assert.equal(c.matchesCreated, null);
  assert.equal(c.phase.key, "IN_TOURNAMENT");
  assert.equal(c.phase.detail, "1 claim · challenge window open");
});

test("consensusPhase: the ladder, in contract order", () => {
  const b = { staged: false, isFinished: false, isFailed: false, standing: null, joined: null, canAccept: null };
  assert.equal(consensusPhase(null), null);
  assert.equal(consensusPhase({ ...b, staged: true }).key, "STAGED");
  assert.equal(
    consensusPhase({ ...b, staged: true, canAccept: [true, false, true, 0n, H0, H0] }).key,
    "AWAITING_ACCEPTANCE",
  );
  // staged wins even if the tournament also reads as finished
  assert.equal(consensusPhase({ ...b, staged: true, isFinished: true }).key, "STAGED");
  assert.equal(consensusPhase({ ...b, isFinished: true, isFailed: true }).key, "FAILED");
  assert.equal(consensusPhase({ ...b, isFinished: true }).key, "AWAITING_STAGING");
  assert.equal(consensusPhase({ ...b, standing: standingOf("MATCHES_ACTIVE"), joined: 2n }).key, "DISPUTE");
  assert.equal(consensusPhase({ ...b, standing: standingOf("AWAITING_CLOSURE"), joined: 0n }).key, "AWAITING_CLAIM");
  assert.equal(consensusPhase({ ...b, standing: null, joined: 0 }).key, "AWAITING_CLAIM");
  const two = consensusPhase({ ...b, standing: standingOf("AWAITING_CLOSURE"), joined: 2n });
  assert.equal(two.key, "IN_TOURNAMENT");
  assert.equal(two.detail, "2 claims · challenge window open");
  assert.equal(consensusPhase({ ...b, standing: standingOf("AWAITING_CLOSURE") }).detail, "challenge window open");
  assert.equal(consensusPhase({ ...b }).key, "SEALED");
  for (const p of Object.values({ a: consensusPhase({ ...b }), f: consensusPhase({ ...b, isFinished: true, isFailed: true }) }))
    assert.match(css, new RegExp(`\\.status-${p.tone}\\s*\\{`));
  assert.ok(isLivePhase({ key: "DISPUTE" }));
  assert.ok(isLivePhase({ key: "STAGED" }));
  assert.ok(!isLivePhase({ key: "IN_TOURNAMENT" }));
  assert.ok(!isLivePhase(null));
});

test("fetchConsensusState: no client, no address, or a failing primary read → null", async () => {
  assert.equal(await fetchConsensusState({ l1Client: null, consensusAddress: CONS }), null);
  assert.equal(await fetchConsensusState({ l1Client: stubChain(), consensusAddress: null }), null);
  assert.equal(await fetchConsensusState({ l1Client: stubChain({}, 1000n), consensusAddress: CONS }), null);
});

test("fetchConsensusState: zero tournament and partial failures degrade rather than throw", async () => {
  const chain = stubChain(
    {
      [`${CONS}|getCurrentSealedEpoch`]: sealedTuple(2, ZERO_ADDR),
      [`${CONS}|canStageTournamentResult`]: new Error("boom"),
    },
    new Error("rpc down"),
  );
  const c = await fetchConsensusState({ l1Client: chain, consensusAddress: CONS });
  assert.equal(c.tournament, null);
  assert.equal(c.isFinished, null);
  assert.equal(c.standing, null);
  assert.equal(c.currentBlock, null);
  assert.equal(c.phase.key, "SEALED");
  assert.ok(!chain.calls.some((x) => x.startsWith(`${ZERO_ADDR}|`)));
});

test("staged: canAccept is read by fetchConsensusState and reused, staging block from the contract", async () => {
  const chain = stubChain(
    {
      [`${CONS}|getCurrentSealedEpoch`]: sealedTuple(7, TADDR, true, 950n),
      [`${CONS}|canStageTournamentResult`]: canStageTuple(true, false),
      [`${CONS}|canAcceptStagedTournamentResult`]: [true, false, false, 7n, HX(0xaa), HX(0xbb)],
      [`${CONS}|getNumberOfSentries`]: 0n,
      [`${TADDR}|tournamentStanding`]: standingTuple(2),
      [`${TADDR}|getCommitmentJoinedCount`]: 1n,
    },
    1000n,
  );
  const c = await fetchConsensusState({ l1Client: chain, consensusAddress: CONS });
  assert.equal(c.phase.key, "STAGED");
  assert.equal(c.stagingBlockNumber, 950n);
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode({ tournaments: [T(TADDR, 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: chain,
    // the node still says CLAIM_COMPUTED and has no staged_at_block
    epoch: { index: 7n, status: "CLAIM_COMPUTED", tournamentAddress: TADDR },
    claimStagingPeriod: 100n,
    consensus: c,
  });
  assert.equal(chain.calls.filter((x) => x.endsWith("canAcceptStagedTournamentResult")).length, 1);
  assert.ok(out.staging);
  assert.equal(out.staging.blocksLeft, 50n);
  assert.equal(out.currentBlock, 1000n);
  assert.match(describeStaging(out).text, /^accepts in 50/);
  const row = describeSettling({ epoch: { index: 7n, status: "CLAIM_COMPUTED" }, consensus: c, prt: out });
  assert.equal(row.label, "STAGED");
  assert.equal(row.nodeNote, "node: CLAIM COMPUTED");
});

test("contract says not staged: the node's STAGED label does not trigger consensus reads", async () => {
  const chain = stubChain({}, 1000n);
  const c = { epochNumber: 7n, tournament: TADDR, staged: false, isFinished: false, isFailed: false, standing: null, joined: 1n, canAccept: null, currentBlock: 1000n };
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode(),
    l1Client: chain,
    epoch: { index: 7n, status: "CLAIM_STAGED", stagedAtBlock: 950n, tournamentAddress: TADDR },
    claimStagingPeriod: 100n,
    consensus: c,
  });
  assert.equal(out.staging, null);
  assert.equal(chain.calls.length, 0);
});

const chainOnly = (over = {}) => ({
  epochNumber: 0n,
  inputIndexLowerBound: 0n,
  inputIndexUpperBound: 0n,
  tournament: TADDR,
  staged: false,
  isFinished: true,
  isFailed: true,
  standing: standingOf("ROOT_FAILED"),
  joined: 0n,
  matchesCreated: 0n,
  matchesDeleted: 0n,
  innerTournaments: 0n,
  canAccept: null,
  currentBlock: 1000n,
  ...over,
});

test("node has no tournament rows: the root comes from the chain and the tree says so", async () => {
  const c = chainOnly();
  c.phase = consensusPhase(c);
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode(),
    l1Client: stubChain(),
    epoch: { index: 0n, status: "CLAIM_COMPUTED" },
    consensus: c,
  });
  assert.equal(out.root.address, TADDR);
  assert.equal(out.root.fromChain, true);
  assert.equal(out.root.standing.key, "ROOT_FAILED");
  assert.equal(out.order.length, 1);
  assert.deepEqual(out.chainCounts, { joined: 0, matchesCreated: 0, matchesDeleted: 0, innerTournaments: 0 });
  assert.equal(out.disputed, false);
  assert.equal(out.currentBlock, 1000n);
  const rows = describeTree(out);
  assert.equal(rows[0].kind, "tournament");
  assert.equal(rows[0].label, "root");
  assert.equal(rows[0].standing.label, "FAILED — NO WINNER");
  assert.ok(rows.some((r) => r.kind === "note" && /node has not indexed this tournament/.test(r.label)));
});

test("chain counters flag a dispute the node never indexed", async () => {
  const c = chainOnly({
    isFinished: false,
    isFailed: false,
    standing: standingOf("MATCHES_ACTIVE"),
    joined: 2n,
    matchesCreated: 1n,
  });
  c.phase = consensusPhase(c);
  const out = await fetchPrtState({
    ...base,
    nodeClient: stubNode(),
    l1Client: stubChain(),
    epoch: { index: 0n, status: "CLAIM_SUBMITTED" },
    consensus: c,
  });
  assert.equal(out.disputed, true);
  const d = describeDispute(out);
  assert.equal(d.standing.label, "DISPUTE ACTIVE");
  assert.equal(d.meta, "2 commitments · 1/1 matches active · from chain");
  const row = describeSettling({ epoch: { index: 0n, status: "CLAIM_SUBMITTED" }, consensus: c, prt: out });
  assert.equal(row.label, "DISPUTE ACTIVE");
  assert.equal(row.detail, null); // the dispute line below carries the counts
  assert.equal(row.nodeNote, "node: IN TOURNAMENT");
});

test("node rows present: node standing stays, chain fills a missing one, no chain counts", async () => {
  const c = chainOnly({ isFinished: false, isFailed: false, standing: standingOf("AWAITING_CLOSURE"), joined: 1n, epochNumber: 7n });
  const noSnap = await fetchPrtState({
    ...base,
    nodeClient: stubNode({ tournaments: [T(TADDR, 0)] }),
    l1Client: stubChain(),
    consensus: c,
  });
  assert.equal(noSnap.root.standing.key, "AWAITING_CLOSURE");
  assert.equal(noSnap.chainCounts, null);
  const withSnap = await fetchPrtState({
    ...base,
    nodeClient: stubNode({ tournaments: [T(TADDR, 0, null, tSnap("ROOT_WINNER"))] }),
    l1Client: stubChain(),
    consensus: c,
  });
  assert.equal(withSnap.root.standing.key, "ROOT_WINNER");
});

test("epoch missing on the node but sealed on chain still renders", async () => {
  const c = chainOnly({ epochNumber: 3n, inputIndexLowerBound: 2n, inputIndexUpperBound: 5n, isFinished: false, isFailed: false, standing: standingOf("AWAITING_CLOSURE") });
  c.phase = consensusPhase(c);
  const out = await fetchPrtState({ ...base, nodeClient: stubNode(), l1Client: stubChain(), epoch: null, consensus: c });
  assert.equal(out.epochIndex, 3n);
  const row = describeSettling({ epoch: null, consensus: c, prt: out });
  assert.equal(row.label, "AWAITING CLAIM");
  assert.equal(row.epochIndex, 3n);
  assert.equal(row.inputs, 3);
  assert.equal(row.nodeNote, "node has no epoch #3 yet");
});

test("describeSettling without chain state is just the node's status", () => {
  assert.equal(describeSettling({}), null);
  assert.equal(describeSettling({ epoch: null, consensus: null }), null);
  const row = describeSettling({
    epoch: { index: 4n, status: "CLAIM_SUBMITTED", inputIndexLowerBound: 10n, inputIndexUpperBound: 12n },
  });
  assert.equal(row.source, "node");
  assert.equal(row.label, "IN TOURNAMENT");
  assert.equal(row.tone, "pending");
  assert.equal(row.epochIndex, 4n);
  assert.equal(row.inputs, 2);
  assert.equal(row.nodeNote, null);
});

test("describeSettling: matching labels need no note; another epoch on the node is named", () => {
  const c = chainOnly({ epochNumber: 2n, isFinished: false, isFailed: false, standing: standingOf("AWAITING_CLOSURE"), joined: 1n });
  const same = describeSettling({ epoch: { index: 2n, status: "CLAIM_SUBMITTED" }, consensus: c });
  assert.equal(same.label, "IN TOURNAMENT");
  assert.equal(same.nodeNote, null);
  const other = describeSettling({ epoch: { index: 1n, status: "CLAIM_STAGED" }, consensus: c });
  assert.equal(other.epochIndex, 2n);
  assert.equal(other.nodeNote, "node is on epoch #1 · STAGED");
});

test("deriveLastAccepted: the newer of the node's index and the contract's implied one", () => {
  assert.equal(deriveLastAccepted(null, null), null);
  assert.equal(deriveLastAccepted(null, { epochNumber: 0n }), null);
  assert.equal(deriveLastAccepted(null, { epochNumber: 3n }), 2n);
  assert.equal(deriveLastAccepted(4n, { epochNumber: 3n }), 4n);
  assert.equal(deriveLastAccepted(1n, { epochNumber: 5n }), 4n);
  assert.equal(deriveLastAccepted(1n, null), 1n);
  assert.equal(deriveLastAccepted(0n, { epochNumber: 1n }), 0n);
});

test("inputsOf: index bounds to a count, else null", () => {
  assert.equal(inputsOf({ inputIndexLowerBound: 0n, inputIndexUpperBound: 4n }), 4);
  assert.equal(inputsOf({ inputIndexLowerBound: 3, inputIndexUpperBound: 3 }), 0);
  assert.equal(inputsOf({ inputIndexLowerBound: 1n }), null);
  assert.equal(inputsOf(null), null);
});
