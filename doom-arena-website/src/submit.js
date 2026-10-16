// =============================================================
// SUBMIT PREFLIGHT — pure helpers, no DOM, no clients (unit-tested)
// =============================================================
// Two on-chain limits bound a submission, and neither is the backend's
// MAX_GAMEPLAY_LOG_SIZE (1 MiB, unreachable through the InputBox):
//
// 1. InputBox rejects inputs whose EvmAdvance encoding exceeds
//    CanonicalMachine.INPUT_MAX_SIZE (64 KiB) with InputTooLarge. The
//    encoding adds a 292-byte head (selector + 8 words + length word) and
//    pads the payload to 32 bytes, so the largest payload is 65,216 bytes
//    (32-byte outhash + 65,184-byte tape). Measured on Base Sepolia.
//
// 2. EIP-7825 caps a single transaction at 16,777,216 gas (Base Sepolia
//    since 2025-09-03, Ethereum since Fusaka). A full-size addInput needs
//    ~2.65M, so a valid run never gets near it — but a wallet whose own
//    eth_estimateGas fails (no ETH, flaky RPC) falls back to a fraction of
//    the *block* gas limit (1.2B on Base Sepolia) and the node answers
//    "exceeds max transaction gas limit". The site therefore estimates gas
//    itself, with the real sender, and always sends an explicit `gas`.

export const INPUT_MAX_SIZE = 65_536;
export const EVM_ADVANCE_OVERHEAD = 292;
export const MAX_TX_GAS = 16_777_216n;
export const OUTHASH_BYTES = 32;
const GAS_HEADROOM_PCT = 120n;

// Largest addInput payload (bytes) whose padded EvmAdvance encoding fits.
export function maxPayloadBytes() {
  const room = INPUT_MAX_SIZE - EVM_ADVANCE_OVERHEAD;
  return room - (room % 32);
}

const fmtB = (n) => `${n.toLocaleString("en-US")} B`;

// payloadHex is "0x" + outhash + tape.
export function checkPayloadSize(payloadHex) {
  const bytes = Math.ceil((String(payloadHex).length - 2) / 2);
  const max = maxPayloadBytes();
  const ok = bytes <= max;
  return {
    ok,
    bytes,
    max,
    message: ok
      ? null
      : `run too long to submit · tape ${fmtB(bytes - OUTHASH_BYTES)}, chain limit ${fmtB(max - OUTHASH_BYTES)}`,
  };
}

// Gas to put on the transaction: the estimate plus headroom, never above the
// per-transaction cap. An estimate above the cap can't be sent at all.
export function gasForSubmit(estimate) {
  const est = BigInt(estimate);
  if (est > MAX_TX_GAS)
    throw new Error(`needs ${est} gas, above the per-transaction cap of ${MAX_TX_GAS}`);
  const padded = (est * GAS_HEADROOM_PCT) / 100n;
  return padded > MAX_TX_GAS ? MAX_TX_GAS : padded;
}

// Walk err → err.cause → … (viem nests the useful error a few levels down).
function* chain(err) {
  const seen = new Set();
  for (let e = err; e && typeof e === "object" && !seen.has(e); e = e.cause) {
    seen.add(e);
    yield e;
  }
}

const textOf = (err) =>
  [...chain(err)]
    .flatMap((e) => [e.details, e.shortMessage, e.message])
    .filter(Boolean)
    .join("\n");

const firstLine = (s) => String(s ?? "").split("\n")[0];

// One line for the status bar. `chainName` is only decoration.
export function submitErrorMessage(err, chainName = "this chain") {
  for (const e of chain(err)) {
    if (e.data?.errorName === "InputTooLarge") {
      const [, inputLength, maxInputLength] = e.data.args ?? [];
      return `run too long to submit · input ${fmtB(Number(inputLength))}, chain limit ${fmtB(Number(maxInputLength))}`;
    }
  }
  const text = textOf(err);
  const names = new Set([...chain(err)].map((e) => e.name));
  if (names.has("UserRejectedRequestError") || [...chain(err)].some((e) => e.code === 4001))
    return "cancelled in wallet";
  if (names.has("InsufficientFundsError") || /insufficient funds/i.test(text))
    return `wallet has no ${chainName} ETH to pay gas`;
  if (/exceeds max(imum)? (per-transaction )?(transaction )?gas limit|gas required exceeds allowance|above the per-transaction cap/i.test(text))
    return `gas limit above ${chainName} cap (${MAX_TX_GAS.toLocaleString("en-US")})`;
  return err?.details || err?.shortMessage || firstLine(err?.message) || String(err);
}

// -------------------------------------------------------------
// Pending-run state machine
// -------------------------------------------------------------
// The run waiting to go on-chain. A recording that finishes becomes the
// pending run; a failure BEFORE the wallet broadcast keeps it so the player
// can re-send; a failure AFTER the broadcast keeps the tx hash so the player
// can look the receipt up instead of sending the same run twice. Any replay
// wipes it, so a tape fetched from the leaderboard can never be submitted.
//
//   state: null | { payload, score, status, error, txHash }
//   status: idle -> submitting -> sent -> ok
//                              \-> failed        (no hash: re-send allowed)
//                        sent -> unconfirmed     (hash known: check first)
//                 unconfirmed -> failed via "reverted" (re-send allowed)
//
// "idle" is the review step: the run sits there until the player presses
// Submit (or Discard). Nothing is sent without that click.

export function runReducer(state, event) {
  switch (event?.type) {
    case "finished":
      // A replay finishing emits the same rivemuOnFinish; it is not ours.
      // The tape bytes decide, not UI state: a replay being torn down fires
      // its finish after the replay flags are already cleared.
      return event.replaying || event.isReplayTape || !event.payload
        ? null
        : {
            payload: event.payload,
            score: Number.isFinite(event.score) ? event.score : null,
            status: "idle",
            error: null,
            txHash: null,
          };
    case "submit":
    case "resend":
      return state ? { ...state, status: "submitting", error: null, txHash: null } : null;
    case "sent":
      return state
        ? { ...state, status: "sent", txHash: event.txHash ?? state.txHash ?? null, error: null }
        : null;
    case "ok":
      return state
        ? { ...state, status: "ok", txHash: event.txHash ?? state.txHash ?? null, error: null }
        : null;
    case "unconfirmed":
      return state
        ? {
            ...state,
            status: "unconfirmed",
            txHash: event.txHash ?? state.txHash ?? null,
            error: event.error ?? "receipt not seen yet",
          }
        : null;
    case "failed":
      if (!state) return null;
      // Once a hash exists the tx may well be mined: never fall back to a
      // state that allows a blind re-send.
      if (state.txHash)
        return { ...state, status: "unconfirmed", error: event.error ?? "receipt not seen yet" };
      return { ...state, status: "failed", error: event.error ?? "unknown error", txHash: null };
    case "reverted":
      // The chain rejected it: the run is still good, sending again is safe.
      return state
        ? { ...state, status: "failed", error: event.error ?? "transaction reverted", txHash: null }
        : null;
    case "reject": // not submittable at all (bad or oversized payload)
    case "discard": // the player chose not to submit (or is done with it)
    case "replay":
    case "exit-replay":
      return null;
    default:
      return state;
  }
}

export const canSubmit = (state) => state?.status === "idle";
export const canRetry = (state) => state?.status === "failed";
export const canCheck = (state) => state?.status === "unconfirmed";
export const isBusy = (state) => state?.status === "submitting" || state?.status === "sent";

// -------------------------------------------------------------
// Score from the outcard
// -------------------------------------------------------------
// The emulator posts the final outcard with rivemuOnFinish. Doom's outcard is
// "JSON{...}" with a "score" field — the same one the backend regex-extracts
// (src/rives-barebones.cpp) — so the review step can show the local result
// before the rollup proves it. Null when there is no readable score.
export function scoreFromOutcard(outcard) {
  if (!outcard) return null;
  let text;
  try {
    if (typeof outcard === "string") text = outcard;
    else {
      const bytes = outcard instanceof Uint8Array ? outcard : Uint8Array.from(outcard);
      text = new TextDecoder().decode(bytes);
    }
  } catch (_) {
    return null;
  }
  if (text.startsWith("JSON")) {
    try {
      const n = Number(JSON.parse(text.slice(4))?.score);
      if (Number.isFinite(n)) return n;
    } catch (_) {
      // fall through to the regex
    }
  }
  const m = /"score"\s*:\s*(-?\d+)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// -------------------------------------------------------------
// Overlay view-model
// -------------------------------------------------------------
// What the canvas overlay shows for a pending run. Pure: main.js applies it to
// the DOM. `env`: { chainName, explorerUrl, walletAvailable, walletConnected,
// mismatch } — explorerUrl is the chain's block explorer base (or null).
//
//   { kind, eyebrow, score, scoreLabel, text, tx: {hash, url}|null,
//     primary: {label, action, disabled, reason}|null, discard, resend, busy }
const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

export function runOverlayModel(run, env = {}) {
  if (!run) return null;
  const chain = env.chainName || "this chain";
  const tx = run.txHash
    ? {
        hash: run.txHash,
        short: shortHash(run.txHash),
        url: env.explorerUrl ? `${String(env.explorerUrl).replace(/\/$/, "")}/tx/${run.txHash}` : null,
      }
    : null;
  const base = {
    score: run.score ?? null,
    scoreLabel: run.score == null ? null : "local score · verified onchain after submission",
    tx,
    discard: false,
    resend: false,
    busy: false,
    hint: null,
  };
  switch (run.status) {
    case "idle": {
      let disabled = false;
      let reason = null;
      let hint = null;
      if (env.mismatch?.length) {
        disabled = true;
        reason = "submissions disabled · config mismatch";
      } else if (!env.walletAvailable) {
        disabled = true;
        reason = "install a wallet to submit · your run is kept while this page is open";
      } else if (!env.walletConnected) {
        hint = "your wallet will ask to connect first";
      }
      return {
        ...base,
        kind: "review",
        eyebrow: "// run recorded",
        text: `Submitting posts your gameplay to the InputBox on ${chain}; your wallet will ask you to sign one transaction (gas only). The rollup replays it to prove the score.`,
        primary: { label: "Submit run", action: "submit", disabled, reason },
        discard: true,
        hint,
      };
    }
    case "submitting":
      return {
        ...base,
        kind: "submitting",
        eyebrow: "// submitting",
        text: "confirm the transaction in your wallet…",
        primary: null,
        busy: true,
      };
    case "sent":
      return {
        ...base,
        kind: "sent",
        eyebrow: "// sent",
        text: "waiting for confirmation…",
        primary: null,
        busy: true,
      };
    case "ok":
      return {
        ...base,
        kind: "ok",
        eyebrow: "// posted onchain ✓",
        text: "the node is processing it · the Rollup state panel counts it as “being processed” until the node picks it up · it can take a few minutes to show up on the leaderboard",
        primary: { label: "Play again", action: "again", disabled: false, reason: null },
      };
    case "failed":
      return {
        ...base,
        kind: "failed",
        eyebrow: "// submit failed",
        text: "your run is kept · sort out the wallet or network and retry",
        error: run.error ?? "unknown error",
        primary: { label: "Retry submit", action: "submit", disabled: false, reason: null },
        discard: true,
      };
    case "unconfirmed":
      return {
        ...base,
        kind: "unconfirmed",
        eyebrow: "// not confirmed yet",
        text: "check your wallet before sending again",
        error: run.error ?? "receipt not seen yet",
        primary: { label: "Check status", action: "check", disabled: false, reason: null },
        resend: true,
        discard: true,
      };
    default:
      return null;
  }
}

// Byte-for-byte equality of two tapes (Uint8Array or array-like); false when
// either is missing.
export function sameBytes(a, b) {
  if (!a || !b || a.length == null || b.length == null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
