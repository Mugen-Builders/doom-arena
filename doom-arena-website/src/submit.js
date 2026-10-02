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
