// =============================================================
// DOOM ARENA — main app
// =============================================================
// - Wallet connect (window.ethereum + viem walletClient)
// - Live leaderboard (cartesi_listOutputs, notices only, paged → decode)
// - Per-row onchain verify (validateOutput)
// - In-canvas replay (cartesi_getInput → postMessage to emulator iframe)
// - Submit flow (rivemuOnFinish → inputBox.addInput)
// - Rollup state (cartesi_listEpochs + getLastAcceptedEpochIndex; under PRT
//   the sealed epoch's state is read from the consensus contract, tournaments
//   from node snapshots with the on-chain counters as fallback)
//
// Node: rollups-node next/2.0 (PR #798 shapes). Talks to it through the thin
// client in ./nodeRpc; the node must allow this site's origin via
// CARTESI_JSONRPC_CORS_ALLOWED_ORIGINS or the browser never sees a reply.
// =============================================================

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  decodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  isHex,
  toHex,
  toBytes,
  fromHex,
} from "viem"; // "https://esm.sh/viem@2.50.4"; //"viem";
import {
  checkPayloadSize,
  gasForSubmit,
  submitErrorMessage,
  runReducer,
  canRetry,
  canCheck,
  isBusy,
  sameBytes,
  OUTHASH_BYTES,
} from "./submit";
import { baseSepolia, anvil, sepolia, mainnet, base } from "viem/chains"; // "https://esm.sh/viem@2.50.4/chains"; //"viem/chains";

import * as CFG from "./config";
import * as CONSTS from "./consts";
import {
  createNodeClient,
  listAllOutputs,
  OUTPUT_SELECTOR,
  NodeRpcError,
  NodeShapeError,
  NodeTransportError,
  isNotFound,
  isConfigError,
  isTransient,
  isUnsupportedNode,
} from "./nodeRpc";
import {
  epochStatus,
  NON_TERMINAL_PAST_OPEN,
  fetchPrtState,
  fetchConsensusState,
  deriveLastAccepted,
  isLivePhase,
  inputsOf,
  describeSettling,
  describeStaging,
  describeDispute,
  describeTree,
} from "./prt";

const EMULATOR_URL = CFG.EMULATOR_URL || "https://emulator.rives.io";
const CARTRIDGES_URL = CFG.CARTRIDGES_URL || "";

export const chains = {};
chains[sepolia.id] = sepolia;
chains[baseSepolia.id] = baseSepolia;
chains[mainnet.id] = mainnet;
chains[base.id] = base;

chains[anvil.id] = anvil;
// const customChain = defineChain({
//   ...anvil,
//   rpcUrls: {
//     default: { http: [`${CFG.NODE_URL}/anvil`] },
//   },
// });
// chains[customChain.id] = customChain;

export function getChain(chainId) {
  var numericChainId;

  if (typeof chainId === "string") {
    if (!isHex(chainId)) {
      console.error(`Invalid hex chain ID: ${chainId}`);
      return null;
    }
    numericChainId = fromHex(chainId, "number");
  } else {
    numericChainId = chainId;
  }

  const chain = chains[numericChainId];
  if (!chain) {
    console.error(`Chain not found for ID: ${numericChainId}`);
    return null;
  }

  return chain;
}

// rollups-node JSON-RPC (listEpochs, listOutputs, getInput, …)
const nodeClient = createNodeClient({ url: `${CFG.NODE_URL}/rpc` });

// The node resolves either the registered name or the address.
const APP_REF = CFG.APPLICATION_NAME || CFG.APPLICATION_ADDRESS;

// CFG.CHAIN_ID may be a hex string or a number.
const CFG_CHAIN_ID =
  typeof CFG.CHAIN_ID === "string" ? fromHex(CFG.CHAIN_ID, "number") : CFG.CHAIN_ID;

// L1 client for validateOutput / waitForTransactionReceipt / PRT contract reads.
// batch:true collapses a refresh's eth_calls into few HTTP round trips, which
// matters once per-tournament reads are added on top of a public endpoint.
// Falls back to the chain's default RPC when L1_RPC_URL is unset.
const l1Client = createPublicClient({
  chain: getChain(CFG.CHAIN_ID),
  transport: http(CFG.L1_RPC_URL || undefined, { batch: true }),
});

// -------------------------------------------------------------
// helpers
// -------------------------------------------------------------
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const fmtAddrShort = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
// Node RPC values are interpolated into innerHTML below; escape them rather
// than trusting whatever the node hands back.
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmtScore = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fmtAge = (ts) => {
  if (!ts) return "—";
  const d = new Date(typeof ts === "string" ? ts : Number(ts));
  if (isNaN(d.getTime())) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

const humanError = (e) => {
  if (e instanceof NodeRpcError) return `node: ${e.rpcMessage} (${e.code})`;
  if (e instanceof NodeShapeError) return `node: unexpected response at ${e.field}`;
  if (e instanceof NodeTransportError) return `node unreachable: ${e.message.split(": ").slice(1).join(": ")}`;
  return e?.details || e?.shortMessage || e?.message?.split("\n")[0] || String(e);
};

// =============================================================
// EMULATOR
// =============================================================
function setEmulatorUrl(params = {}) {
  const emulator = document.getElementById("emulator-iframe");
  if (!emulator) return;
  let src = `${EMULATOR_URL}/#`;
  if (CARTRIDGES_URL) src += `&cartridge=${CARTRIDGES_URL}`;
  if (params.tapeUrl !== undefined) src += `&tape=${params.tapeUrl}`;
  if (params.simple !== undefined) src += `&simple=${params.simple}`;
  if (params.autoplay !== undefined) src += `&autoplay=${params.autoplay}`;
  if (params.entropy) src += `&entropy=${encodeURIComponent(params.entropy)}`;
  if (CONSTS.BG_HUE != null) src += `&hue=${CONSTS.BG_HUE}`;
  if (CONSTS.BG_SAT != null) src += `&sat=${CONSTS.BG_SAT}`;
  if (CONSTS.BG_LIGHT != null) src += `&light=${CONSTS.BG_LIGHT}`;
  if (CONSTS.BG_ALPHA != null) src += `&alpha=${CONSTS.BG_ALPHA}`;
  if (params.extra) src += `&${params.extra}`;
  emulator.src = src;
  $("#game-frame").classList.add("iframe-loaded");
}

function setStatus(text, tone) {
  const el = $("#foot-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.tone = tone || "";
}

// =============================================================
// WALLET
// =============================================================
let CONNECTED_ADDR = null;
let WALLET_CLIENT = null;

async function getWalletClient() {
  if (!window.ethereum) return null;
  const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
  const currentChainId = fromHex(chainIdHex, "number");
  if (currentChainId !== CFG_CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: toHex(CFG_CHAIN_ID) }],
      });
    } catch (_) {
      throw new Error(`Wrong network — switch to ${getChain(CFG_CHAIN_ID)?.name ?? CFG_CHAIN_ID}`);
    }
  }
  const [address] = await window.ethereum.request({
    method: "eth_requestAccounts",
  });
  if (!address) return null;
  return createWalletClient({
    account: address,
    chain: getChain(CFG.CHAIN_ID),
    transport: custom(window.ethereum),
  });
}

async function setupWallet() {
  const btn = $("#connect-btn");
  if (!window.ethereum) {
    btn.textContent = "Install Wallet";
    $("#net-dot").style.backgroundColor = "var(--warn)";
    btn.addEventListener("click", () =>
      window.open("https://ethereum.org/wallets", "_blank"),
    );
    setEmulatorUrl({ simple: true });
    return;
  }
  const refresh = async () => {
    try {
      const accounts = await window.ethereum.request({
        method: "eth_accounts",
      });
      CONNECTED_ADDR = accounts && accounts.length ? accounts[0] : null;
      btn.textContent = CONNECTED_ADDR
        ? fmtAddrShort(CONNECTED_ADDR)
        : "Connect Wallet";
      if (CONNECTED_ADDR) {
        try {
          WALLET_CLIENT = await getWalletClient();
        } catch (_) {
          WALLET_CLIENT = null;
          $("#net-dot").style.backgroundColor = "var(--bad)";
        }
        $("#net-dot").style.backgroundColor = "var(--ok)";
        setEmulatorUrl({ simple: true, entropy: CONNECTED_ADDR.toLowerCase() });
      } else {
        WALLET_CLIENT = null;
        setEmulatorUrl({ simple: true });
        $("#net-dot").style.backgroundColor = "var(--unnavailable)";
      }
      renderBoard();
    } catch (_) {}
  };
  btn.addEventListener("click", async () => {
    try {
      await window.ethereum.request({ method: "eth_requestAccounts" });
    } catch (_) {}
    refresh();
  });
  window.ethereum.on?.("accountsChanged", refresh);
  window.ethereum.on?.("chainChanged", refresh);
  refresh();
}

// =============================================================
// SUBMIT
// =============================================================
const inputBoxAbi = parseAbi([
  "function addInput(address _app, bytes payload) payable",
  "error InputTooLarge(address appContract, uint256 inputLength, uint256 maxInputLength)",
]);

// Gas is estimated here, with the real sender on our own L1 RPC, and sent
// explicitly. Left to the wallet, a failed estimate (no ETH for gas, flaky
// wallet RPC) makes MetaMask fall back to a fraction of the block gas limit,
// which on Base Sepolia (1.2B) is far above the 16,777,216 per-transaction
// cap and gets the tx rejected with "exceeds max transaction gas limit".
// Limits and numbers: see ./submit.js.
async function submitGameplay(payload) {
  // A stale config.js would send the run to an InputBox the node is not
  // watching; that loses the run silently. Refuse instead.
  if (LIFECYCLE_STATE.mismatch.length)
    throw new Error(`config mismatch — ${LIFECYCLE_STATE.mismatch[0]}`);
  const size = checkPayloadSize(payload);
  if (!size.ok) throw new Error(size.message);
  if (!WALLET_CLIENT) WALLET_CLIENT = await getWalletClient();
  if (!WALLET_CLIENT) throw new Error("wallet not connected");

  const call = {
    account: WALLET_CLIENT.account,
    address: CFG.INPUT_BOX_ADDRESS,
    abi: inputBoxAbi,
    functionName: "addInput",
    args: [CFG.APPLICATION_ADDRESS, payload],
    value: 0n,
  };
  // simulate first: an eth_call decodes reverts (InputTooLarge) regardless
  // of the sender's balance; estimateGas then surfaces "insufficient funds".
  const { request } = await l1Client.simulateContract(call);
  const estimate = await l1Client.estimateContractGas(call);
  // Returns as soon as the wallet broadcast the tx; the receipt is awaited
  // separately (confirmSubmission) so a flaky RPC after the broadcast can
  // never turn into a second identical submission.
  return WALLET_CLIENT.writeContract({
    ...request,
    gas: gasForSubmit(estimate),
  });
}

// Outcome of a broadcast tx: "success" | "reverted" | null (not seen within
// the timeout). Never throws.
const RECEIPT_TIMEOUT_MS = 120_000;
async function confirmSubmission(txHash) {
  try {
    const receipt = await l1Client.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    return receipt?.status === "reverted" ? "reverted" : "success";
  } catch (err) {
    console.warn("receipt wait failed:", humanError(err));
  }
  try {
    const receipt = await l1Client.getTransactionReceipt({ hash: txHash });
    if (receipt) return receipt.status === "reverted" ? "reverted" : "success";
  } catch (_) {
    // not found (or RPC down): unknown
  }
  return null;
}

// The run waiting to go on-chain, driven by runReducer (./submit.js): set when
// a recording finishes, kept through a failed submit so it can be retried or
// its receipt looked up, wiped by any replay so a leaderboard tape is never
// submitted.
let PENDING_RUN = null;
// Tape bytes of the replay last loaded into the emulator. Stopping a replay
// (including exiting it, which resets the frame through a hash change) makes
// the emulator emit rivemuOnFinish with THIS tape; the bytes are the reliable
// way to tell that finish apart from a real recording.
let REPLAY_TAPE = null;
// Set while a replay is being torn down; a finish arriving then is dropped.
// Cleared by that finish or by a timer, so a missing finish (replay already
// over) cannot swallow the next real recording.
let REPLAY_STOPPING = false;
let replayStoppingTimer = null;
const REPLAY_STOPPING_MS = 3_000;
// Payloads broadcast this session -> tx hash. The same run is never sent
// twice without the player explicitly asking.
const SUBMITTED_PAYLOADS = new Map();

const SUBMIT_NOTE_MS = 20_000;
// The node needs a moment to process the input; refresh the board a few times.
const BOARD_REFRESH_AFTER_SUBMIT_MS = [1_500, 15_000, 60_000];
let noteTimer = null;

const shortTx = (h) => (h ? `${h.slice(0, 10)}…` : "—");

function renderSubmitControls() {
  const controls = $("#submit-controls");
  const btn = $("#retry-submit");
  const again = $("#resend-submit");
  if (!controls || !btn) return;
  const retry = canRetry(PENDING_RUN);
  const check = canCheck(PENDING_RUN);
  controls.hidden = !(retry || check);
  btn.textContent = check ? "↻ check status" : "↻ retry submit";
  btn.title = check ? "Look the transaction up again" : "Submit the last run again";
  if (again) again.hidden = !check;
}

function dispatchRun(event) {
  PENDING_RUN = runReducer(PENDING_RUN, event);
  renderSubmitControls();
}

// Good news fades; a warning stays until the next action replaces it.
function showSubmitNote(text, tone) {
  const el = $("#submit-note");
  if (!el) return;
  clearTimeout(noteTimer);
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.dataset.tone = tone || "";
  if (tone !== "bad")
    noteTimer = setTimeout(() => {
      el.hidden = true;
    }, SUBMIT_NOTE_MS);
}

const replayActive = () =>
  $("#game-frame")?.classList.contains("is-replay") || $("#replay-controls")?.hidden === false;

const isReplayPayload = (payload) =>
  !!REPLAY_TAPE && sameBytes(toBytes(payload).slice(OUTHASH_BYTES), REPLAY_TAPE);

// Wait for the pending run's receipt and settle the state accordingly.
async function settlePending() {
  const run = PENDING_RUN;
  if (!run?.txHash) return;
  const { txHash, payload } = run;
  const outcome = await confirmSubmission(txHash);
  // The state moved on (a replay, a new run) while we waited.
  if (!PENDING_RUN || PENDING_RUN.txHash !== txHash) return;
  if (outcome === "success") {
    dispatchRun({ type: "ok", txHash });
    setStatus(`submitted ✓ tx ${shortTx(txHash)}`, "ok");
    showSubmitNote(
      "run posted onchain · it can take a few minutes to show up on the leaderboard while the node processes it",
      "ok",
    );
    for (const ms of BOARD_REFRESH_AFTER_SUBMIT_MS) setTimeout(fetchLeaderboard, ms);
  } else if (outcome === "reverted") {
    SUBMITTED_PAYLOADS.delete(payload);
    dispatchRun({ type: "reverted", error: "transaction reverted" });
    setStatus(`tx ${shortTx(txHash)} reverted onchain`, "bad");
    showSubmitNote("the transaction reverted · your run is kept, retry sends it again", "bad");
  } else {
    dispatchRun({ type: "unconfirmed", txHash, error: "receipt not seen yet" });
    setStatus(`tx ${shortTx(txHash)} sent · not confirmed yet`, "bad");
    showSubmitNote(
      `tx ${shortTx(txHash)} was broadcast but this RPC has not shown a receipt · check your wallet before sending again`,
      "bad",
    );
  }
}

// Look an unconfirmed tx up again without touching the wallet.
async function checkPending() {
  if (!PENDING_RUN?.txHash || isBusy(PENDING_RUN)) return;
  dispatchRun({ type: "sent", txHash: PENDING_RUN.txHash });
  setStatus(`checking tx ${shortTx(PENDING_RUN.txHash)}…`);
  showSubmitNote(null);
  await settlePending();
}

async function submitPending({ resend = false } = {}) {
  if (!PENDING_RUN || isBusy(PENDING_RUN)) return;
  if (replayActive()) {
    // Belt and braces: a replay started between the run finishing and now.
    dispatchRun({ type: "replay" });
    return;
  }
  const { payload } = PENDING_RUN;
  if (isReplayPayload(payload)) {
    dispatchRun({ type: "reject" });
    setStatus("not submitting a replayed run", "bad");
    return;
  }
  if (canCheck(PENDING_RUN) && !resend) return checkPending();
  const prior = SUBMITTED_PAYLOADS.get(payload);
  if (prior && !resend) {
    dispatchRun({ type: "unconfirmed", txHash: prior, error: "already broadcast" });
    setStatus(`this run was already sent · tx ${shortTx(prior)}`, "bad");
    showSubmitNote(
      `this run was already sent as tx ${shortTx(prior)} · check its status before sending it again`,
      "bad",
    );
    return;
  }

  dispatchRun({ type: resend ? "resend" : "submit" });
  setStatus("submitting run…");
  showSubmitNote(null);
  let txHash;
  try {
    txHash = await submitGameplay(payload);
  } catch (err) {
    // Nothing was broadcast: re-sending is safe.
    console.error("submit failed:", err);
    const chainName = getChain(CFG.CHAIN_ID)?.name ?? "this chain";
    const reason = submitErrorMessage(err, chainName);
    dispatchRun({ type: "failed", error: reason });
    setStatus(`submit failed · ${reason}`, "bad");
    showSubmitNote("your run is kept · sort out the wallet or network and retry", "bad");
    return;
  }
  SUBMITTED_PAYLOADS.set(payload, txHash);
  dispatchRun({ type: "sent", txHash });
  setStatus(`sent · tx ${shortTx(txHash)} · waiting for confirmation`);
  await settlePending();
}

window.addEventListener("message", (e) => {
  const params = e.data;
  if (!params || typeof params !== "object") return;
  if (!(params.rivemuOnFinish && params.outhash && params.tape)) return;

  const isReplayTape = sameBytes(params.tape, REPLAY_TAPE);
  const stopping = REPLAY_STOPPING;
  REPLAY_STOPPING = false;
  clearTimeout(replayStoppingTimer);

  const gameplayPayload = `0x${params.outhash}${toHex(params.tape).slice(2)}`;
  dispatchRun({
    type: "finished",
    payload: gameplayPayload,
    replaying: replayActive() || stopping,
    isReplayTape,
  });
  if (!PENDING_RUN) {
    // A replay finished or was stopped: never submit a leaderboard tape.
    if (stopping) setStatus("replay stopped");
    return;
  }

  if (!isHex(gameplayPayload)) {
    dispatchRun({ type: "reject" });
    setStatus("invalid payload", "bad");
    return;
  }
  // Too long for the InputBox: say so before the wallet ever opens.
  const size = checkPayloadSize(gameplayPayload);
  if (!size.ok) {
    dispatchRun({ type: "reject" });
    setStatus(size.message, "bad");
    return;
  }
  submitPending();
});

$("#retry-submit")?.addEventListener("click", () => submitPending());
$("#resend-submit")?.addEventListener("click", () => submitPending({ resend: true }));

// =============================================================
// ICONS
// =============================================================
const ICON_CHAIN = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M6.5 9.5a2.5 2.5 0 0 1 0-3l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10 9.5"/><path d="M9.5 6.5a2.5 2.5 0 0 1 0 3L8 11a2.5 2.5 0 0 1-3.5-3.5L6 6.5"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 7 12 13 4.5"/></svg>`;
const ICON_X = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4 12 12 M12 4 4 12"/></svg>`;
const ICON_SPIN = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" class="spin"><path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" opacity="0.85"/></svg>`;
const ICON_DASH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.55"><path d="M4 8 H12"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3 L13 8 L5 13 Z"/></svg>`;

// =============================================================
// LEADERBOARD
// =============================================================
let BOARD = [];
let BOARD_ERROR = null;
let BOARD_TOTAL = null; // node-side notice count, only when the cap truncated
let BOARD_FATAL = false; // config error: polling the board again cannot help
let SELECTED_RUN_IDX = null;
let VERIFY_STATE = {};

// Newest 2,000 notices are enough for a leaderboard; beyond that the board
// says "top N of M". 20 pages of 100 stay well inside the node's per-request
// and per-batch budgets.
const BOARD_CAP = 2000;
const BOARD_PAGE = 100;

function decodeVerificationNotice(output) {
  try {
    const decodedData = output.decodedData || {};
    if (decodedData.type !== "Notice") return null;
    const payload = decodedData.payload;
    if (!payload || !isHex(payload)) return null;
    const decoded = decodeAbiParameters(
      parseAbiParameters(
        "address user, uint256 timestamp, int256 score, uint256 input_index",
      ),
      payload,
    );
    return {
      user: decoded[0],
      timestamp: decoded[1],
      score: decoded[2],
      inputIndex: decoded[3],
      payload: output.rawData,
      proof: output.outputHashesSiblings
        ? {
            outputIndex: output.index,
            outputHashesSiblings: output.outputHashesSiblings,
          }
        : null,
    };
  } catch (_) {
    return null;
  }
}

async function fetchLeaderboard() {
  if (BOARD_FATAL) return;
  try {
    // Notices only (the node filters by selector), newest first, paged.
    const res = await listAllOutputs(nodeClient, {
      application: APP_REF,
      outputType: OUTPUT_SELECTOR.Notice,
      descending: true,
      pageSize: BOARD_PAGE,
      cap: BOARD_CAP,
    });
    BOARD_TOTAL = res.truncated ? res.totalCount : null;
    const notices = res.data.map(decodeVerificationNotice).filter(Boolean);
    notices.sort((a, b) => {
      const d = Number(b.score - a.score);
      return d !== 0 ? d : Number(a.timestamp - b.timestamp);
    });
    BOARD = notices.map((n, i) => ({
      rank: i + 1,
      user: n.user,
      score: Number(n.score),
      ts: Number(n.timestamp) * 1000,
      inputIndex: n.inputIndex,
      payload: n.payload,
      proof: n.proof,
      verifiable: !!n.proof,
    }));
    BOARD_ERROR = null;
  } catch (e) {
    console.warn("leaderboard fetch failed:", humanError(e));
    BOARD_ERROR = humanError(e);
    if (isConfigError(e) || isUnsupportedNode(e)) {
      // Wrong app name/address or wrong node generation: retrying is noise.
      BOARD = [];
      BOARD_TOTAL = null;
      BOARD_FATAL = true;
    } else if (!isTransient(e)) {
      BOARD = [];
      BOARD_TOTAL = null;
    }
    // transient: keep the last good board under the error note
  }
  renderBoard();
}

function renderBoard() {
  const board = $("#scoreboard");
  board.innerHTML = "";

  if (BOARD_ERROR) {
    const note = document.createElement("div");
    note.className = "board-note";
    note.textContent = `live unreachable · ${BOARD_ERROR}`;
    board.appendChild(note);
  }

  if (!BOARD.length) {
    const empty = document.createElement("div");
    empty.className = "board-empty";
    empty.textContent = BOARD_ERROR ? "no data" : "no runs yet · be the first";
    board.appendChild(empty);
    $("#board-count").textContent = "— runs";
    return;
  }

  BOARD.forEach((r, i) => {
    const row = document.createElement("div");
    row.className =
      "board-row" +
      (i < 3 ? " top" : "") +
      (i === SELECTED_RUN_IDX ? " active" : "");
    const me =
      CONNECTED_ADDR && r.user.toLowerCase() === CONNECTED_ADDR.toLowerCase();
    if (me) row.classList.add("me");

    const key = String(r.inputIndex);
    const vstate = VERIFY_STATE[key] || "idle";
    const verifyTitle = !r.verifiable
      ? "not yet finalized"
      : vstate === "ok"
        ? "verified onchain"
        : vstate === "bad"
          ? "verification failed"
          : vstate === "busy"
            ? "verifying onchain…"
            : "verify onchain";
    const verifyIcon = !r.verifiable
      ? ICON_DASH
      : vstate === "ok"
        ? ICON_CHECK
        : vstate === "bad"
          ? ICON_X
          : vstate === "busy"
            ? ICON_SPIN
            : ICON_CHAIN;

    row.innerHTML = `
      <span class="col-rank">${String(r.rank).padStart(2, "0")}</span>
      <span class="col-player"><span>${fmtAddrShort(r.user)}</span></span>
      <span class="col-score">${fmtScore(r.score)}</span>
      <button class="col-verify v-${vstate}${r.verifiable ? "" : " disabled"}"
              data-i="${i}" title="${verifyTitle}" ${r.verifiable ? "" : "disabled"}>${verifyIcon}</button>
      <button class="col-play" data-i="${i}" title="Replay run">${ICON_PLAY}</button>
    `;
    row.querySelector(".col-verify").addEventListener("click", (e) => {
      e.stopPropagation();
      verifyRow(i);
    });
    row.querySelector(".col-play").addEventListener("click", (e) => {
      e.stopPropagation();
      loadReplay(i);
    });
    row.addEventListener("click", () => loadReplay(i));
    board.appendChild(row);
  });
  $("#board-count").textContent =
    BOARD_TOTAL != null
      ? `top ${BOARD.length} of ${BOARD_TOTAL} runs`
      : `${BOARD.length} run${BOARD.length === 1 ? "" : "s"}`;
}

async function verifyRow(i) {
  const r = BOARD[i];
  if (!r || !r.verifiable) return;
  const key = String(r.inputIndex);
  VERIFY_STATE[key] = "busy";
  renderBoard();
  try {
    const ok = await validateGameplay(r.payload, r.proof);
    VERIFY_STATE[key] = ok ? "ok" : "bad";
  } catch (e) {
    console.warn("verify failed:", humanError(e));
    VERIFY_STATE[key] = "bad";
  }
  renderBoard();
}

async function validateGameplay(payload, proof) {
  if (!payload || !proof) throw new Error("missing payload / proof");
  await l1Client.readContract({
    address: CFG.APPLICATION_ADDRESS,
    abi: parseAbi([
      "function validateOutput(bytes,(uint64,bytes32[])) view",
      "error InvalidOutputHashesSiblingsArrayLength()",
      "error InvalidOutputsMerkleRoot(bytes32 outputsMerkleRoot)",
    ]),
    functionName: "validateOutput",
    args: [payload, [proof.outputIndex, proof.outputHashesSiblings]],
  });
  return true;
}

// =============================================================
// REPLAY
// =============================================================
const frame = () => $("#game-frame");
let __uploadListener = null;

async function loadReplay(i) {
  SELECTED_RUN_IDX = i;
  const r = BOARD[i];
  if (!r) return;
  // A leaderboard tape is never ours to submit.
  dispatchRun({ type: "replay" });
  showSubmitNote(null);
  scrollToEmulator();
  frame().classList.add("is-replay");
  $("#replay-meta").textContent =
    `run #${String(r.rank).padStart(2, "0")} · ${fmtAddrShort(r.user)}`;
  $("#replay-controls").hidden = false;
  setStatus(`loading replay · input #${r.inputIndex}`);

  try {
    const res = await nodeClient.getInput({
      application: APP_REF,
      inputIndex: r.inputIndex,
    });
    if (!res.decodedData?.payload) throw new Error("input has no decoded payload");
    const inputBytes = toBytes(res.decodedData.payload);
    // Strip the first 32 bytes (outhash) — what remains is the gameplay tape.
    const tape = inputBytes.slice(OUTHASH_BYTES);
    REPLAY_TAPE = tape;

    // Clear any pending upload listener from a previous replay
    if (__uploadListener) {
      window.removeEventListener("message", __uploadListener);
      __uploadListener = null;
    }
    __uploadListener = (e) => {
      if (e.data?.rivemuUploaded) {
        const emulator = document.getElementById("emulator-iframe");
        if (emulator?.contentWindow) {
          emulator.contentWindow.postMessage(
            {
              rivemuUpload: true,
              tape,
              autoPlay: true,
              entropy: r.user?.toLowerCase(),
            },
            "*",
          );
        }
        window.removeEventListener("message", __uploadListener);
        __uploadListener = null;
        setStatus(`replaying · input #${r.inputIndex}`);
      }
    };
    window.addEventListener("message", __uploadListener);
    setEmulatorUrl({});
  } catch (e) {
    console.error("replay load failed:", e);
    setStatus(`replay failed · ${humanError(e)}`, "bad");
  }
  renderBoard();
}

function exitReplay() {
  SELECTED_RUN_IDX = null;
  dispatchRun({ type: "exit-replay" });
  showSubmitNote(null);
  // Resetting the frame below stops the replay, and the emulator reports
  // that stop as a finish carrying the replayed tape. Drop it.
  REPLAY_STOPPING = true;
  clearTimeout(replayStoppingTimer);
  replayStoppingTimer = setTimeout(() => {
    REPLAY_STOPPING = false;
  }, REPLAY_STOPPING_MS);
  frame().classList.remove("is-replay");
  $("#replay-controls").hidden = true;
  if (__uploadListener) {
    window.removeEventListener("message", __uploadListener);
    __uploadListener = null;
  }
  setEmulatorUrl(
    CONNECTED_ADDR
      ? { simple: true, entropy: CONNECTED_ADDR.toLowerCase() }
      : { simple: true },
  );
  setStatus("READY");
  renderBoard();
}

$("#exit-replay")?.addEventListener("click", exitReplay);
$("#rp-prev")?.addEventListener("click", () => {
  if (!BOARD.length) return;
  const next =
    SELECTED_RUN_IDX == null
      ? 0
      : (SELECTED_RUN_IDX - 1 + BOARD.length) % BOARD.length;
  loadReplay(next);
});
$("#rp-next")?.addEventListener("click", () => {
  if (!BOARD.length) return;
  const next =
    SELECTED_RUN_IDX == null ? 0 : (SELECTED_RUN_IDX + 1) % BOARD.length;
  loadReplay(next);
});

// =============================================================
// SCROLL TO EMULATOR
// =============================================================
function scrollToEmulator() {
  const el = $("#game-frame");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  if (r.height > 0 && visible / r.height >= 0.8) return; // already in view
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
}

// The emulator is a cross-origin iframe and posts nothing when a run starts.
// The first click inside it (the big play/record button included) moves focus
// into the frame, which this window sees as a blur with the iframe as the
// active element. Focus already being inside the frame (a tab switch) is
// ignored; a click back on the page re-arms it.
let iframeHadFocus = false;
const emulatorEl = () => document.getElementById("emulator-iframe");
window.addEventListener("blur", () => {
  const inIframe = document.activeElement === emulatorEl();
  if (inIframe && !iframeHadFocus) scrollToEmulator();
  iframeHadFocus = inIframe;
});
window.addEventListener("focus", () => {
  iframeHadFocus = document.activeElement === emulatorEl();
});
document.addEventListener("pointerdown", (e) => {
  if (!emulatorEl()?.contains(e.target)) iframeHadFocus = false;
});

// =============================================================
// LIFECYCLE
// =============================================================
let LIFECYCLE_STATE = {
  nodeInfo: null, // cartesi_getNodeInfo — the startup gate
  unsupported: null, // message when the node is not the generation we target
  fatal: null, // config error from the node: polling cannot fix it
  mismatch: [], // config.js vs node disagreements; non-empty blocks submit
  lastAcceptedIndex: null, // node's view, or the contract's (sealed − 1), whichever is newer
  acceptedEpoch: null, // node Epoch for lastAcceptedIndex — its input count
  currentEpoch: null, // newest epoch — where inputs go
  settlingEpoch: null, // the sealed epoch consensus is working on (node's record of it)
  consensus: null, // fetchConsensusState — the chain's view of the sealed epoch (PRT)
  loading: false,
  error: null,
  app: null, // cached cartesi_getApplication — static config
  prt: null, // PRT view-model, null under authority/quorum
  expanded: false,
};

const isPrt = () => LIFECYCLE_STATE.app?.consensusType === "PRT";

const sameAddr = (a, b) =>
  !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// What config.js says vs what the node says. Any disagreement means the bundle
// was built for another deployment; see submitGameplay().
function crossCheckConfig() {
  const { nodeInfo, app } = LIFECYCLE_STATE;
  const out = [];
  if (nodeInfo && nodeInfo.chainId !== CFG_CHAIN_ID)
    out.push(`node is on chain ${nodeInfo.chainId}, site is configured for ${CFG_CHAIN_ID}`);
  if (app && !sameAddr(app.inputBoxAddress, CFG.INPUT_BOX_ADDRESS))
    out.push(`node InputBox is ${app.inputBoxAddress}, site has ${CFG.INPUT_BOX_ADDRESS}`);
  if (app && !sameAddr(app.applicationAddress, CFG.APPLICATION_ADDRESS))
    out.push(`node application is ${app.applicationAddress}, site has ${CFG.APPLICATION_ADDRESS}`);
  LIFECYCLE_STATE.mismatch = out;
}

// Polling cadence. The leaderboard changes at human pace; consensus state does
// not. While a dispute is live or a staged claim is counting down in ~2s
// blocks, a 60s tick makes the countdown useless, so poll faster — but only
// then. Transient node trouble (timeouts, oversized replies, network) doubles
// the interval per failure up to POLL_MAX and resets on success.
const POLL_IDLE = 60_000;
const POLL_LIVE = 12_000;
const POLL_MAX = 300_000;
let pollBackoff = 1;

async function fetchLifecycle() {
  if (LIFECYCLE_STATE.unsupported || LIFECYCLE_STATE.fatal) return;
  LIFECYCLE_STATE.loading = true;
  renderLifecycle();
  try {
    const safe = (p) =>
      p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));

    // Startup gate: a node without cartesi_getNodeInfo is an older generation
    // whose payloads we no longer parse. Say so once and stop.
    if (!LIFECYCLE_STATE.nodeInfo) {
      LIFECYCLE_STATE.nodeInfo = await nodeClient.getNodeInfo();
    }

    // Application is deployment config — fetch once and keep it.
    if (!LIFECYCLE_STATE.app) {
      LIFECYCLE_STATE.app = await nodeClient.getApplication({ application: APP_REF });
      crossCheckConfig();
    }

    // Two views of the epoch list: the newest epoch (collecting inputs) and
    // the oldest one consensus is still working on. Under PRT the tournament
    // hangs off the latter; the former is usually just OPEN.
    const [newestR, settlingR, lastR] = await Promise.all([
      safe(nodeClient.listEpochs({ application: APP_REF, descending: true, limit: 1 })),
      safe(
        nodeClient.listEpochs({
          application: APP_REF,
          status: NON_TERMINAL_PAST_OPEN,
          descending: false,
          limit: 1,
        }),
      ),
      safe(nodeClient.getLastAcceptedEpochIndex({ application: APP_REF })),
    ]);
    if (!newestR.ok) throw newestR.e;
    if (!settlingR.ok) throw settlingR.e;

    LIFECYCLE_STATE.currentEpoch = newestR.v.data[0] ?? null;
    let settling = settlingR.v.data[0] ?? null;

    // "No accepted epoch yet" is a state, not an error.
    let nodeLastAccepted;
    if (lastR.ok) nodeLastAccepted = lastR.v;
    else if (isNotFound(lastR.e)) nodeLastAccepted = null;
    else throw lastR.e;

    // Under PRT the chain decides which epoch is sealed and what state it is
    // in; the node's label for it can be stale (a claim it computed but never
    // submitted stays CLAIM_COMPUTED while the tournament fails on-chain).
    // Under authority/quorum no chain calls are issued.
    let consensus = null;
    if (isPrt()) {
      consensus = await fetchConsensusState({
        l1Client,
        consensusAddress: LIFECYCLE_STATE.app?.consensusAddress,
        // counters only matter when the node has no tournament rows; the
        // previous poll tells us whether it did
        nodeHasTournaments: (LIFECYCLE_STATE.prt?.tournaments?.length ?? 0) > 0,
      });
      // Use the node's record of the sealed epoch itself (for its label and
      // bounds), not whichever epoch the node thinks it is working on.
      if (
        consensus &&
        (!settling || BigInt(settling.index) !== BigInt(consensus.epochNumber))
      ) {
        const r = await safe(
          nodeClient.getEpoch({ application: APP_REF, epochIndex: consensus.epochNumber }),
        );
        settling = r.ok ? r.v : null;
      }
    }
    LIFECYCLE_STATE.settlingEpoch = settling;
    LIFECYCLE_STATE.consensus = consensus;

    LIFECYCLE_STATE.prt =
      isPrt() && (settling || consensus)
        ? await fetchPrtState({
            nodeClient,
            l1Client,
            application: APP_REF,
            consensusAddress: LIFECYCLE_STATE.app?.consensusAddress,
            epoch: settling,
            claimStagingPeriod: LIFECYCLE_STATE.app?.claimStagingPeriod,
            consensus,
          })
        : null;

    // Last accepted: the node's index or the contract's implied one, whichever
    // is newer; fetch that epoch once for its input count.
    const lastIdx = deriveLastAccepted(nodeLastAccepted, consensus);
    LIFECYCLE_STATE.lastAcceptedIndex = lastIdx;
    if (lastIdx == null) {
      LIFECYCLE_STATE.acceptedEpoch = null;
    } else if (
      LIFECYCLE_STATE.acceptedEpoch == null ||
      BigInt(LIFECYCLE_STATE.acceptedEpoch.index) !== BigInt(lastIdx)
    ) {
      const r = await safe(nodeClient.getEpoch({ application: APP_REF, epochIndex: lastIdx }));
      LIFECYCLE_STATE.acceptedEpoch = r.ok ? r.v : null;
    }

    LIFECYCLE_STATE.error = null;
    pollBackoff = 1;
  } catch (e) {
    console.warn("lifecycle fetch failed:", humanError(e));
    if (isUnsupportedNode(e)) {
      LIFECYCLE_STATE.unsupported = `unsupported node — this site needs rollups-node next/2.0 (${humanError(e)})`;
    } else if (isConfigError(e)) {
      LIFECYCLE_STATE.fatal = humanError(e);
    } else if (isTransient(e)) {
      // Keep the last good picture on screen; just note the trouble and slow down.
      LIFECYCLE_STATE.error = humanError(e);
      pollBackoff = Math.min(pollBackoff * 2, POLL_MAX / POLL_IDLE);
    } else {
      LIFECYCLE_STATE.error = humanError(e);
      LIFECYCLE_STATE.lastAcceptedIndex = null;
      LIFECYCLE_STATE.acceptedEpoch = null;
      LIFECYCLE_STATE.currentEpoch = null;
      LIFECYCLE_STATE.settlingEpoch = null;
      LIFECYCLE_STATE.consensus = null;
      LIFECYCLE_STATE.prt = null;
    }
  }
  LIFECYCLE_STATE.loading = false;
  renderLifecycle();
  if (!LIFECYCLE_STATE.unsupported && !LIFECYCLE_STATE.fatal) schedulePoll();
}

// ~2s blocks on Base Sepolia; good enough to turn a block delta into a feel.
const BLOCK_SECONDS = 2;

const fmtInputs = (n) => (n == null ? "— inputs" : `${n} input${n === 1 ? "" : "s"}`);

// One epoch row: state (with its dot) on the left, epoch number on the right.
function setEpochHead(id, label, tone, index, pulse) {
  const st = $(`#lc-${id}-status`);
  if (st) {
    st.textContent = label;
    st.className = `status status-${tone}`;
  }
  const dot = $(`#lc-${id}-dot`);
  if (dot) {
    dot.dataset.tone = tone;
    dot.classList.toggle("pulse", !!pulse);
  }
  const idx = $(`#lc-${id}-idx`);
  if (idx) idx.textContent = index == null ? "epoch —" : `epoch #${index}`;
}

function renderLifecycle() {
  const {
    lastAcceptedIndex,
    acceptedEpoch,
    currentEpoch,
    settlingEpoch,
    consensus,
    error,
    prt,
    app,
    unsupported,
    fatal,
    mismatch,
  } = LIFECYCLE_STATE;

  const consensusPill = $("#lc-consensus-pill");
  if (consensusPill) {
    consensusPill.textContent = app?.consensusType ?? "—";
    consensusPill.title = app?.consensusAddress
      ? `consensus ${app.consensusAddress}`
      : "";
  }

  // ---- settling (sealed) epoch: contract phase first, node label as a note
  const settling = describeSettling({ epoch: settlingEpoch, consensus, prt });

  // ---- OPEN (newest) epoch; folded into the settling row when it is the same
  const openEl = $("#lc-open");
  const openIsSettling =
    !!currentEpoch &&
    !!settling &&
    settling.epochIndex != null &&
    BigInt(currentEpoch.index) === BigInt(settling.epochIndex);
  if (openEl) {
    if (currentEpoch && !openIsSettling) {
      const st = epochStatus(currentEpoch);
      setEpochHead("open", st.label, st.tone, currentEpoch.index, st.tone === "open");
      $("#lc-open-inputs").textContent = fmtInputs(inputsOf(currentEpoch));
      openEl.hidden = false;
    } else {
      openEl.hidden = true;
    }
  }

  const settlingEl = $("#lc-settling");
  if (settlingEl) {
    if (settling) {
      const live = isLivePhase({ key: settling.key });
      setEpochHead("settling", settling.label, settling.tone, settling.epochIndex, live);
      $("#lc-settling-inputs").textContent = fmtInputs(settling.inputs);
      $("#lc-settling-detail").textContent = settling.detail ?? "";
      const noteEl = $("#lc-settling-node");
      noteEl.hidden = !settling.nodeNote;
      noteEl.textContent = settling.nodeNote ?? "";
      settlingEl.hidden = false;
    } else {
      settlingEl.hidden = true;
    }
  }

  // ---- last accepted epoch
  if ($("#lc-accepted")) {
    if (lastAcceptedIndex != null) {
      setEpochHead("accepted", "ACCEPTED", "ok", lastAcceptedIndex, false);
      $("#lc-accepted-inputs").textContent = acceptedEpoch
        ? fmtInputs(inputsOf(acceptedEpoch))
        : "— inputs";
      $("#lc-accepted-detail").textContent = "";
    } else {
      setEpochHead("accepted", "ACCEPTED", "dim", null, false);
      $("#lc-accepted-inputs").textContent = "no accepted epoch yet";
      $("#lc-accepted-detail").textContent = "";
    }
  }

  renderStaging(prt);
  renderDispute(prt);
  renderTree(prt);

  // One line for whatever the operator must know: an unsupported node, a
  // config error, a config mismatch, or transient trouble.
  const note = $("#lc-note");
  if (note) {
    let text = null;
    let tone = "bad";
    if (unsupported) text = unsupported;
    else if (fatal) text = `node rejected the request — ${fatal}`;
    else if (mismatch.length)
      text = `config mismatch · submissions disabled · ${mismatch.join(" · ")}`;
    else if (error) {
      text = `node trouble — ${error}${pollBackoff > 1 ? ` · retrying in ${Math.round(pollInterval() / 1000)}s` : ""}`;
      tone = "warn";
    }
    note.hidden = !text;
    note.textContent = text ?? "";
    note.className = `lc-note mono status-${tone}`;
  }
  if (mismatch.length) setStatus("config mismatch — submissions disabled", "bad");

  // The How-modal shows both values when they differ, so the operator can see
  // which side is stale.
  const ibox = $("#modal-ibox");
  if (ibox && app?.inputBoxAddress) {
    ibox.textContent = sameAddr(app.inputBoxAddress, CFG.INPUT_BOX_ADDRESS)
      ? fmtAddrShort(CFG.INPUT_BOX_ADDRESS)
      : `site ${fmtAddrShort(CFG.INPUT_BOX_ADDRESS)} · node ${fmtAddrShort(app.inputBoxAddress)}`;
  }
}

function renderStaging(prt) {
  const el = $("#lc-staging");
  if (!el) return;
  const d = describeStaging(prt, BLOCK_SECONDS);
  if (!d) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const text = $("#lc-staging-text");
  text.textContent = d.text;
  text.className = `mono ${d.tone === "bad" ? "status-bad" : d.tone === "ok" ? "status-ok" : "dim"}`;
}

function renderDispute(prt) {
  const el = $("#lc-dispute");
  if (!el) return;
  const d = describeDispute(prt);
  if (!d) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  // The row head above already names the phase when the chain provided it;
  // repeat the standing only when it adds something.
  const head = describeSettling({
    epoch: LIFECYCLE_STATE.settlingEpoch,
    consensus: LIFECYCLE_STATE.consensus,
    prt,
  });
  const badge = $("#lc-dispute-standing");
  badge.textContent = d.standing.label;
  badge.className = `status status-${d.standing.tone}`;
  badge.hidden = !!head && head.label === d.standing.label;
  $("#lc-dispute-meta").textContent = d.meta;
  $("#lc-dispute-toggle").textContent = LIFECYCLE_STATE.expanded
    ? "hide tournament ▴"
    : "show tournament ▾";
}

function renderTree(prt) {
  const el = $("#lc-tree");
  if (!el) return;
  if (!prt || !prt.disputed || !LIFECYCLE_STATE.expanded) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const rows = describeTree(prt, BLOCK_SECONDS);
  const html = rows
    .map((r) => {
      if (r.kind === "tournament")
        return `<div class="lc-tree-row" style="--depth:${r.depth}">
             <span class="mono lc-tree-lvl">${esc(r.label)}</span>
             <span class="mono dim lc-tree-id" title="${esc(r.address)}">${esc(fmtAddrShort(r.address))}</span>
             <span class="status status-${esc(r.standing?.tone ?? "pending")}">${esc(r.standing?.label ?? "—")}</span>
           </div>`;
      if (r.kind === "match")
        return `<div class="lc-tree-row lc-tree-match" style="--depth:${r.depth}">
             <span class="mono dim lc-tree-id" title="${esc(r.idHash)}">${esc(fmtAddrShort(r.idHash))}</span>
             <span class="mono lc-tree-label ${r.active ? "" : "dim"}">${esc(r.label)}</span>
           </div>`;
      return `<div class="lc-tree-row dim mono">${esc(r.label)}</div>`;
    })
    .join("");

  el.innerHTML =
    html ||
    `<div class="lc-tree-row dim mono">no tournament detail available</div>`;
}

// Everything the tree shows arrives with the collapsed fetch, so the toggle is
// a pure re-render.
$("#lc-dispute-toggle")?.addEventListener("click", () => {
  LIFECYCLE_STATE.expanded = !LIFECYCLE_STATE.expanded;
  renderDispute(LIFECYCLE_STATE.prt);
  renderTree(LIFECYCLE_STATE.prt);
});

// =============================================================
// CONF DISPLAY
// =============================================================
$("#modal-app").textContent = fmtAddrShort(CFG.APPLICATION_ADDRESS);
$("#modal-ibox").textContent = fmtAddrShort(CFG.INPUT_BOX_ADDRESS);
$("#modal-chain").textContent = getChain(CFG.CHAIN_ID).name;
$("#hero-chain").textContent =
  `LIVE ON ${getChain(CFG.CHAIN_ID).name.toUpperCase()}`;
$("#net-label").textContent = getChain(CFG.CHAIN_ID).name.toUpperCase();

// =============================================================
// MODAL
// =============================================================
function openModal() {
  $("#how-modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeModal() {
  $("#how-modal").hidden = true;
  document.body.style.overflow = "";
  if (location.hash === "#how")
    history.replaceState(null, "", location.pathname);
}
$$('a[href="#how"]').forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openModal();
  }),
);
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#how-modal").hidden) closeModal();
});
if (location.hash === "#how") openModal();

// =============================================================
// RELOAD
// =============================================================
$("#reload-btn")?.addEventListener("click", async () => {
  const btn = $("#reload-btn");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "↻ reloading…";
  await Promise.all([fetchLeaderboard(), fetchLifecycle()]);
  setTimeout(() => {
    btn.textContent = old;
    btn.disabled = false;
  }, 300);
});

// =============================================================
// cartridge label — click to copy the application address
// =============================================================
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // insecure context or permission denied: fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

{
  const chip = $("#cartridge-id");
  let copyTimer = null;
  chip.textContent = fmtAddrShort(CFG.APPLICATION_ADDRESS);
  chip.title = `${CFG.APPLICATION_ADDRESS} · click to copy`;
  chip.addEventListener("click", async () => {
    const ok = await copyText(CFG.APPLICATION_ADDRESS);
    chip.classList.remove("copied", "copy-failed");
    void chip.offsetWidth; // restart the flash animation on rapid clicks
    chip.dataset.label = ok ? "copied ✓" : "copy failed";
    chip.classList.add(ok ? "copied" : "copy-failed");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => chip.classList.remove("copied", "copy-failed"), 1200);
  });
}

// =============================================================
// boot — fetch both, then poll (cadence: see POLL_* above)
// =============================================================
let pollTimer = null;

function pollInterval() {
  const prt = LIFECYCLE_STATE.prt;
  let base = POLL_IDLE;
  if (prt) {
    const counting = prt.staging && prt.staging.isOver === false;
    const contested = prt.disputed && prt.activeMatchCount > 0;
    if (counting || contested) base = POLL_LIVE;
  }
  if (isLivePhase(LIFECYCLE_STATE.consensus?.phase)) base = POLL_LIVE;
  // Transient node trouble stretches the interval; see fetchLifecycle().
  return Math.min(base * pollBackoff, POLL_MAX);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    fetchLeaderboard();
    fetchLifecycle(); // reschedules itself when it settles
  }, pollInterval());
}

setupWallet();
fetchLeaderboard();
fetchLifecycle(); // schedules the next poll when it settles
