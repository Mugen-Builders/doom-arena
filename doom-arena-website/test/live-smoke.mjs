// Live smoke test against a real rollups-node (next/2.0 + PR #798). Needs
// network, so it is NOT part of `npm test`. Run:
//   npm run smoke -- [nodeUrl] [application] [chainId]
// Defaults to a local devnet node (http://localhost:10011, app doom_arena,
// chain 31337). L1 reads use L1_RPC_URL when set, else the chain's default RPC.
import { createPublicClient, http } from "viem";
import * as chains from "viem/chains";

import {
  createNodeClient,
  listAllOutputs,
  OUTPUT_SELECTOR,
  isNotFound,
  isUnsupportedNode,
} from "../src/nodeRpc.js";
import { fetchPrtState, epochStatus, isSettled, NON_TERMINAL_PAST_OPEN } from "../src/prt.js";

const NODE_URL = process.argv[2] ?? "http://localhost:10011";
const APP = process.argv[3] ?? "doom_arena";
const CHAIN_ID = Number(process.argv[4] ?? 31337);
const L1_RPC_URL = process.env.L1_RPC_URL || undefined;

const chain = Object.values(chains).find((c) => c?.id === CHAIN_ID);
const node = createNodeClient({ url: `${NODE_URL}/rpc` });
const l1 = createPublicClient({ chain, transport: http(L1_RPC_URL, { batch: true }) });

let failures = 0;
const check = (ok, msg, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

console.log(`node=${NODE_URL}  app=${APP}  chain=${CHAIN_ID}  l1=${L1_RPC_URL ?? "(chain default)"}\n`);

// ---- gate -------------------------------------------------------------------
let info;
try {
  info = await node.getNodeInfo();
  console.log(`node info: ${JSON.stringify(info)}`);
  check(true, "cartesi_getNodeInfo answers (node is the generation we target)");
  check(info.chainId === CHAIN_ID, "node chain id matches", `${info.chainId} vs ${CHAIN_ID}`);
} catch (e) {
  check(false, "cartesi_getNodeInfo answers", e.message);
  console.log(
    isUnsupportedNode(e)
      ? "\nthis node predates next/2.0 — nothing else can pass"
      : "\nnode unreachable — nothing else can pass",
  );
  process.exit(1);
}

// ---- application ------------------------------------------------------------
const app = await node.getApplication({ application: APP });
console.log(
  `consensusType=${app.consensusType} consensus=${app.consensusAddress} inputBox=${app.inputBoxAddress} app=${app.applicationAddress}\n`,
);
check(["AUTHORITY", "QUORUM", "PRT"].includes(app.consensusType), "consensus type is a known value", app.consensusType);
check(app.claimStagingPeriod != null, "application carries claim_staging_period");

// ---- epochs -----------------------------------------------------------------
const newest = await node.listEpochs({ application: APP, descending: true, limit: 1 });
const settling = await node.listEpochs({
  application: APP,
  status: NON_TERMINAL_PAST_OPEN,
  descending: false,
  limit: 1,
});
console.log(`epochs: total=${newest.pagination.totalCount} newest=#${newest.data[0]?.index ?? "—"} settling=#${settling.data[0]?.index ?? "—"}`);
check(newest.pagination.totalCount >= 0, "listEpochs returns pagination.total_count");
for (const e of [...newest.data, ...settling.data]) {
  const st = epochStatus(e);
  console.log(`  #${e.index}  ${String(e.status).padEnd(18)} -> ${st.label} (${st.tone})  tournament=${e.tournamentAddress ?? "—"} virtual=${e.virtualIndex}`);
  check(st.label !== "—", `epoch #${e.index} status is mapped`, e.status);
}
if (settling.data[0]) {
  check(!isSettled(settling.data[0]) && settling.data[0].status !== "OPEN", "status filter returns a non-terminal, non-OPEN epoch");
}

let lastAccepted = null;
try {
  lastAccepted = await node.getLastAcceptedEpochIndex({ application: APP });
  check(true, "getLastAcceptedEpochIndex", `#${lastAccepted}`);
} catch (e) {
  check(isNotFound(e), "getLastAcceptedEpochIndex: absent is -31001, not another error", e.message);
}

// ---- outputs ----------------------------------------------------------------
const board = await listAllOutputs(node, {
  application: APP,
  outputType: OUTPUT_SELECTOR.Notice,
  descending: true,
  pageSize: 100,
  cap: 2000,
});
console.log(`notices: ${board.data.length} of ${board.totalCount}${board.truncated ? " (truncated)" : ""}`);
check(board.data.every((o) => o.decodedData?.type === "Notice"), "output_type filter returns notices only");
if (board.data.length > 1) check(board.data[0].index > board.data[1].index, "descending:true is honoured (newest first)");
if (board.data.length) {
  const input = await node.getInput({ application: APP, inputIndex: board.data[0].inputIndex });
  check(!!input.decodedData?.payload, "getInput returns a decoded payload for a notice's input");
  check(input.transactionHash != null, "input carries transaction_hash (next/2.0 shape)");
}

// ---- PRT --------------------------------------------------------------------
const isPrt = app.consensusType === "PRT";
console.log(`\nPRT path ${isPrt ? "ENABLED" : "SKIPPED (degrade path)"}`);
const prt = await fetchPrtState({
  nodeClient: node,
  l1Client: l1,
  application: APP,
  consensusAddress: app.consensusAddress,
  epoch: settling.data[0] ?? newest.data[0] ?? null,
  claimStagingPeriod: app.claimStagingPeriod,
});
check(prt !== undefined && prt !== null, "fetchPrtState returned without throwing");
console.log(
  `  disputed=${prt.disputed} tournaments=${prt.tournaments.length} commitments=${prt.commitmentCount} matches=${prt.matchCount} snapshotOk=${prt.snapshotOk} asOfBlock=${prt.asOfBlock} currentBlock=${prt.currentBlock}`,
);
if (prt.tournaments.length) {
  check(prt.snapshotOk === true, "every tournament carries a snapshot (PR #798)");
  check(prt.root?.standing != null, "root tournament standing comes from the snapshot", prt.root?.standing?.key);
}
if (!isPrt) check(prt.disputed === false && prt.tournaments.length === 0, "non-PRT deployment reports no dispute and no tournaments");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
