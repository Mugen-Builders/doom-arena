// =============================================================
// DOOM ARENA — main app
// =============================================================
// - Wallet connect (window.ethereum + viem walletClient)
// - Live leaderboard (cartesi listOutputs → decode Notice)
// - Per-row onchain verify (validateOutput)
// - In-canvas replay (getInput → postMessage to emulator iframe)
// - Submit flow (rivemuOnFinish → inputBox.addInput)
// - Rollup state (listEpochs + getLastAcceptedEpoch)
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
import { baseSepolia, anvil, sepolia, mainnet, base } from "viem/chains"; // "https://esm.sh/viem@2.50.4/chains"; //"viem/chains";
import {
  publicActionsL1,
  createCartesiPublicClient,
  walletActionsL1,
} from "@cartesi/viem"; //"https://esm.sh/@cartesi/viem@2.0.0-alpha.29"; // "@cartesi/viem";

import * as CFG from "./config";
import * as CONSTS from "./consts";

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

// Cartesi-aware L2 client (listEpochs, listOutputs, getInput, …)
const cartesiPublicClient = createCartesiPublicClient({
  transport: http(`${CFG.NODE_URL}/rpc`),
});

// L1 client for validateOutput / waitForTransactionReceipt
const l1Client = createPublicClient({
  chain: getChain(CFG.CHAIN_ID),
  transport: http(),
}).extend(publicActionsL1());

// -------------------------------------------------------------
// helpers
// -------------------------------------------------------------
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const fmtAddrShort = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
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

const humanError = (e) =>
  e?.details || e?.shortMessage || e?.message?.split("\n")[0] || String(e);

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
  if (currentChainId !== CFG.CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: CFG.CHAIN_ID.toString(16) }],
      });
    } catch (_) {
      throw new Error(`Wrong network — switch to ${baseSepolia.name}`);
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
  }).extend(walletActionsL1());
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
]);

async function submitGameplay(payload) {
  if (!WALLET_CLIENT) WALLET_CLIENT = await getWalletClient();
  if (!WALLET_CLIENT) throw new Error("wallet not connected");

  const { request } = await l1Client.simulateContract({
    account: WALLET_CLIENT.account,
    address: CFG.INPUT_BOX_ADDRESS,
    abi: inputBoxAbi,
    functionName: "addInput",
    args: [CFG.APPLICATION_ADDRESS, payload],
    value: 0n,
  });
  const txHash = await WALLET_CLIENT.writeContract(request);
  await l1Client.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

window.addEventListener("message", async (e) => {
  const params = e.data;
  if (!params || typeof params !== "object") return;

  if (params.rivemuOnFinish && params.outhash && params.tape) {
    if ($("#replay-controls").hidden == false) {
      return;
    }
    try {
      const gameplayPayload = `0x${params.outhash}${toHex(params.tape).slice(2)}`;
      if (!isHex(gameplayPayload)) {
        setStatus("invalid payload", "bad");
        return;
      }
      setStatus("submitting run…");
      const txHash = await submitGameplay(gameplayPayload);
      setStatus(`submitted ✓ tx ${txHash.slice(0, 10)}…`, "ok");
      setTimeout(fetchLeaderboard, 1500);
    } catch (err) {
      console.error("submit failed:", err);
      setStatus(`submit failed · ${humanError(err)}`, "bad");
    }
  }
});

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
let SELECTED_RUN_IDX = null;
let VERIFY_STATE = {};

function decodeVerificationNotice(output) {
  try {
    const decodedData = output.decodedData || {};
    const type = String(decodedData.type || "").toLowerCase();
    if (type !== "notice") return null;
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
  try {
    const res = await cartesiPublicClient.listOutputs({
      application: CFG.APPLICATION_ADDRESS,
    });
    const outputs = Array.isArray(res) ? res : (res?.data ?? []);
    const notices = outputs.map(decodeVerificationNotice).filter(Boolean);
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
    BOARD = [];
    BOARD_ERROR = humanError(e);
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
      <span class="col-player"><span class="avatar c${i % 6}"></span><span>${fmtAddrShort(r.user)}</span></span>
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
    `${BOARD.length} run${BOARD.length === 1 ? "" : "s"}`;
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
  frame().classList.add("is-replay");
  $("#replay-meta").textContent =
    `run #${String(r.rank).padStart(2, "0")} · ${fmtAddrShort(r.user)}`;
  $("#replay-controls").hidden = false;
  setStatus(`loading replay · input #${r.inputIndex}`);

  try {
    const res = await cartesiPublicClient.getInput({
      application: CFG.APPLICATION_ADDRESS,
      inputIndex: r.inputIndex,
    });
    const inputBytes = toBytes(res.decodedData.payload);
    // Strip the first 32 bytes (outhash) — what remains is the gameplay tape.
    const tape = inputBytes.slice(32);

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
// LIFECYCLE
// =============================================================
let LIFECYCLE_STATE = {
  lastAcceptedIndex: null,
  openEpoch: null,
  fetchedAt: null,
  loading: false,
  error: null,
};

function statusOf(e) {
  const s = (e.status || e.state || "").toString().toLowerCase();
  if (s.includes("accept")) return "accepted";
  if (s.includes("claim")) return "pending";
  if (s.includes("open")) return "open";
  if (s.includes("dispute") || s.includes("rej")) return "bad";
  return s || "open";
}
const indexOf = (e) => e.index ?? e.epochIndex ?? e.id ?? null;
const inputsCount = (e) =>
  e.inputIndexUpperBound != undefined && e.inputIndexLowerBound != undefined
    ? e.inputIndexUpperBound - e.inputIndexLowerBound
    : 0;

async function fetchLifecycle() {
  LIFECYCLE_STATE.loading = true;
  renderLifecycle();
  try {
    const app = CFG.APPLICATION_ADDRESS;
    const safe = (p) =>
      p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));

    const [epochsR, lastR] = await Promise.all([
      safe(cartesiPublicClient.listEpochs({ application: app, limit: 12 })),
      safe(cartesiPublicClient.getLastAcceptedEpochIndex({ application: app })),
    ]);
    if (!epochsR.ok) throw epochsR.e;

    const epochs = Array.isArray(epochsR.v)
      ? epochsR.v
      : (epochsR.v?.data ?? []);
    const last = lastR.ok ? lastR.v : null;
    LIFECYCLE_STATE.lastAcceptedIndex = last;
    LIFECYCLE_STATE.openEpoch =
      epochs.find((e) => statusOf(e) !== "accepted") ?? null;
    LIFECYCLE_STATE.error = null;
  } catch (e) {
    console.warn("lifecycle fetch failed:", humanError(e));
    LIFECYCLE_STATE.error = humanError(e);
    LIFECYCLE_STATE.lastAcceptedIndex = null;
    LIFECYCLE_STATE.openEpoch = null;
  }
  LIFECYCLE_STATE.fetchedAt =
    LIFECYCLE_STATE.openEpoch?.updatedAt ?? new Date();
  LIFECYCLE_STATE.loading = false;
  renderLifecycle();
}

function renderLifecycle() {
  const { lastAcceptedIndex, openEpoch, fetchedAt, error, loading } =
    LIFECYCLE_STATE;

  $("#lc-last").textContent =
    lastAcceptedIndex == null ? "—" : `#${lastAcceptedIndex}`;
  $("#lc-fetched-pill").textContent = loading
    ? "fetching…"
    : fetchedAt
      ? fmtAge(fetchedAt.getTime())
      : "—";

  if (openEpoch) {
    const idx = indexOf(openEpoch);
    const st = statusOf(openEpoch);
    $("#lc-current-status").textContent = st;
    $("#lc-current-status").className = `status status-${st}`;
    $("#lc-current-idx").textContent = `epoch #${idx}`;
    $("#lc-current-inputs").textContent = `${inputsCount(openEpoch)} inputs`;
    $("#lc-current-age").textContent = openEpoch.timestamp
      ? fmtAge(openEpoch.timestamp)
      : "—";
    $("#lc-current").style.display = "";
  } else {
    $("#lc-current").style.display = "none";
  }

  $("#lc-app-pill").textContent = error
    ? `live unreachable`
    : fmtAddrShort(CFG.APPLICATION_ADDRESS);
  $("#lc-app-pill").style.color = error ? "var(--bad)" : "";
}

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
// cartridge label
// =============================================================
$("#cartridge-id").textContent = fmtAddrShort(CFG.APPLICATION_ADDRESS);
$("#cartridge-id").title = CFG.APPLICATION_ADDRESS;

// =============================================================
// boot — fetch both, then poll every 60s
// =============================================================
setupWallet();
fetchLeaderboard();
fetchLifecycle();
setInterval(() => {
  fetchLeaderboard();
  fetchLifecycle();
}, 60_000);
