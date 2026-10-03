// Run with: npm test   (node's built-in runner, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
} from "viem";

import {
  INPUT_MAX_SIZE,
  EVM_ADVANCE_OVERHEAD,
  MAX_TX_GAS,
  maxPayloadBytes,
  checkPayloadSize,
  gasForSubmit,
  submitErrorMessage,
} from "../src/submit.js";

const abi = parseAbi([
  "function addInput(address _app, bytes payload) payable",
  "error InputTooLarge(address appContract, uint256 inputLength, uint256 maxInputLength)",
]);
const APP = "0xaef8aebc5a325079dd4d1ae41ac525c47dc1d9e4";
const hexPayload = (n) => "0x" + "ab".repeat(n);

// -------------------------------------------------------------
// payload size

test("maxPayloadBytes: largest payload whose padded EvmAdvance fits 64 KiB", () => {
  assert.equal(maxPayloadBytes(), 65_216);
  const padded = (n) => EVM_ADVANCE_OVERHEAD + Math.ceil(n / 32) * 32;
  assert.ok(padded(65_216) <= INPUT_MAX_SIZE);
  assert.ok(padded(65_217) > INPUT_MAX_SIZE);
});

test("checkPayloadSize accepts the boundary and rejects one byte over", () => {
  const ok = checkPayloadSize(hexPayload(65_216));
  assert.deepEqual([ok.ok, ok.bytes, ok.max, ok.message], [true, 65_216, 65_216, null]);

  const over = checkPayloadSize(hexPayload(65_217));
  assert.equal(over.ok, false);
  assert.equal(over.bytes, 65_217);
  assert.equal(over.message, "run too long to submit · tape 65,185 B, chain limit 65,184 B");

  const small = checkPayloadSize(hexPayload(48));
  assert.equal(small.ok, true);
});

// -------------------------------------------------------------
// gas

test("gasForSubmit adds 20% headroom", () => {
  assert.equal(gasForSubmit(80_000n), 96_000n);
  assert.equal(gasForSubmit(2_653_502n), 3_184_202n); // full-size payload, measured on Base Sepolia
  assert.equal(gasForSubmit(80_000), 96_000n); // number in, bigint out
});

test("gasForSubmit never exceeds the EIP-7825 cap", () => {
  assert.equal(MAX_TX_GAS, 16_777_216n);
  assert.equal(gasForSubmit(15_000_000n), MAX_TX_GAS); // 18M padded → clamped
  assert.equal(gasForSubmit(MAX_TX_GAS), MAX_TX_GAS);
  assert.throws(() => gasForSubmit(20_000_000n), /above the per-transaction cap of 16777216/);
});

// -------------------------------------------------------------
// error mapping

function revertError(errorName, args) {
  const data = encodeErrorResult({ abi, errorName, args });
  const reverted = new ContractFunctionRevertedError({ abi, data, functionName: "addInput" });
  return new ContractFunctionExecutionError(reverted, {
    abi,
    args: [APP, "0x"],
    contractAddress: "0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac",
    functionName: "addInput",
  });
}

test("submitErrorMessage decodes InputTooLarge", () => {
  const err = revertError("InputTooLarge", [APP, 65_829n, 65_536n]);
  assert.equal(
    submitErrorMessage(err, "Base Sepolia"),
    "run too long to submit · input 65,829 B, chain limit 65,536 B",
  );
});

test("submitErrorMessage: insufficient funds (typed and by text)", () => {
  const typed = new ContractFunctionExecutionError(
    new InsufficientFundsError({ cause: new BaseError("insufficient funds for gas * price + value") }),
    { abi, args: [APP, "0x"], functionName: "addInput" },
  );
  assert.equal(submitErrorMessage(typed, "Base Sepolia"), "wallet has no Base Sepolia ETH to pay gas");
  const raw = new Error("RPC: insufficient funds for transfer");
  assert.equal(submitErrorMessage(raw, "Base Sepolia"), "wallet has no Base Sepolia ETH to pay gas");
});

test("submitErrorMessage: per-transaction gas cap, all wordings", () => {
  for (const msg of [
    'RPC 0x14a34 Custom eth_sendRawTransaction: exceeds max transaction gas limit',
    "exceeds maximum per-transaction gas limit",
    "gas required exceeds allowance (16777216)",
    "needs 20000000 gas, above the per-transaction cap of 16777216",
  ]) {
    assert.equal(
      submitErrorMessage(new Error(msg), "Base Sepolia"),
      "gas limit above Base Sepolia cap (16,777,216)",
      msg,
    );
  }
});

test("submitErrorMessage: wallet rejection", () => {
  const typed = new UserRejectedRequestError(new Error("User rejected the request."));
  assert.equal(submitErrorMessage(typed), "cancelled in wallet");
  const byCode = Object.assign(new Error("User denied transaction signature"), { code: 4001 });
  assert.equal(submitErrorMessage(byCode), "cancelled in wallet");
});

test("submitErrorMessage falls back to the first line / shortMessage", () => {
  assert.equal(submitErrorMessage(new Error("boom\nsecond line")), "boom");
  assert.equal(submitErrorMessage({ shortMessage: "short", message: "long\nlines" }), "short");
  assert.equal(submitErrorMessage(new Error("config mismatch — node is on chain 84532")), "config mismatch — node is on chain 84532");
  assert.equal(submitErrorMessage("plain string"), "plain string");
});

// -------------------------------------------------------------
// pending-run state machine
// -------------------------------------------------------------
import { runReducer, canRetry, canCheck, isBusy, sameBytes } from "../src/submit.js";

const P = "0x" + "ab".repeat(40);

test("a finished recording becomes the pending run", () => {
  const s = runReducer(null, { type: "finished", payload: P, replaying: false });
  assert.deepEqual(s, { payload: P, status: "idle", error: null, txHash: null });
  assert.equal(canRetry(s), false);
});

test("a replay finishing never becomes submittable", () => {
  assert.equal(runReducer(null, { type: "finished", payload: P, replaying: true }), null);
  // ...even when a failed run was pending: the replay's finish must not revive it
  const failed = runReducer(
    runReducer(runReducer(null, { type: "finished", payload: P }), { type: "submit" }),
    { type: "failed", error: "no gas" },
  );
  assert.equal(runReducer(failed, { type: "finished", payload: "0x11", replaying: true }), null);
});

test("failed submit keeps the payload and allows retry; success does not", () => {
  let s = runReducer(null, { type: "finished", payload: P });
  s = runReducer(s, { type: "submit" });
  assert.equal(s.status, "submitting");
  assert.equal(canRetry(s), false);
  s = runReducer(s, { type: "failed", error: "wallet has no ETH" });
  assert.equal(s.status, "failed");
  assert.equal(s.payload, P);
  assert.equal(s.error, "wallet has no ETH");
  assert.equal(canRetry(s), true);
  s = runReducer(s, { type: "submit" });
  s = runReducer(s, { type: "ok", txHash: "0xdead" });
  assert.equal(s.status, "ok");
  assert.equal(s.txHash, "0xdead");
  assert.equal(canRetry(s), false);
});

test("starting or leaving a replay wipes whatever was pending", () => {
  let s = runReducer(null, { type: "finished", payload: P });
  s = runReducer(s, { type: "submit" });
  s = runReducer(s, { type: "failed", error: "x" });
  assert.equal(runReducer(s, { type: "replay" }), null);
  assert.equal(runReducer(s, { type: "exit-replay" }), null);
  assert.equal(runReducer(s, { type: "reject" }), null);
});

test("submit/ok/failed without a pending run stay null; unknown events are no-ops", () => {
  assert.equal(runReducer(null, { type: "submit" }), null);
  assert.equal(runReducer(null, { type: "ok", txHash: "0x1" }), null);
  assert.equal(runReducer(null, { type: "failed", error: "x" }), null);
  const s = runReducer(null, { type: "finished", payload: P });
  assert.equal(runReducer(s, { type: "whatever" }), s);
  assert.equal(runReducer(s, undefined), s);
});

test("a new recording replaces a failed one", () => {
  let s = runReducer(null, { type: "finished", payload: P });
  s = runReducer(runReducer(s, { type: "submit" }), { type: "failed", error: "x" });
  const n = runReducer(s, { type: "finished", payload: "0x22", replaying: false });
  assert.equal(n.payload, "0x22");
  assert.equal(n.status, "idle");
});

test("a finish whose tape is the replayed tape is never a run, whatever the UI flags say", () => {
  assert.equal(runReducer(null, { type: "finished", payload: P, replaying: false, isReplayTape: true }), null);
  const failed = runReducer(
    runReducer(runReducer(null, { type: "finished", payload: P }), { type: "submit" }),
    { type: "failed", error: "x" },
  );
  assert.equal(runReducer(failed, { type: "finished", payload: "0x11", isReplayTape: true }), null);
});

test("after a broadcast the hash is kept; a failure then is 'unconfirmed', never a blind re-send", () => {
  let s = runReducer(null, { type: "finished", payload: P });
  s = runReducer(s, { type: "submit" });
  assert.ok(isBusy(s));
  s = runReducer(s, { type: "sent", txHash: "0xabc" });
  assert.equal(s.status, "sent");
  assert.equal(s.txHash, "0xabc");
  assert.ok(isBusy(s));
  assert.equal(canRetry(s), false);
  assert.equal(canCheck(s), false);
  // a generic failure with a hash present degrades to unconfirmed
  s = runReducer(s, { type: "failed", error: "rpc timeout" });
  assert.equal(s.status, "unconfirmed");
  assert.equal(s.txHash, "0xabc");
  assert.equal(canCheck(s), true);
  assert.equal(canRetry(s), false);
  // checking again goes through sent, then confirms
  s = runReducer(s, { type: "sent" });
  assert.equal(s.txHash, "0xabc");
  s = runReducer(s, { type: "ok" });
  assert.equal(s.status, "ok");
  assert.equal(s.txHash, "0xabc");
  assert.equal(canCheck(s), false);
});

test("unconfirmed explicitly, then reverted -> failed with no hash, re-send allowed", () => {
  let s = runReducer(null, { type: "finished", payload: P });
  s = runReducer(runReducer(s, { type: "submit" }), { type: "sent", txHash: "0x1" });
  s = runReducer(s, { type: "unconfirmed", txHash: "0x1", error: "receipt not seen yet" });
  assert.equal(s.status, "unconfirmed");
  assert.equal(s.error, "receipt not seen yet");
  s = runReducer(s, { type: "reverted" });
  assert.equal(s.status, "failed");
  assert.equal(s.txHash, null);
  assert.equal(canRetry(s), true);
  assert.equal(s.payload, P);
  // resend behaves like submit
  s = runReducer(s, { type: "resend" });
  assert.equal(s.status, "submitting");
  assert.equal(s.txHash, null);
});

test("canRetry and canCheck are exclusive across every status", () => {
  for (const status of ["idle", "submitting", "sent", "ok", "unconfirmed", "failed"]) {
    const s = { payload: P, status, error: null, txHash: status === "idle" ? null : "0x1" };
    assert.ok(!(canRetry(s) && canCheck(s)), status);
  }
  assert.equal(canCheck(null), false);
  assert.equal(isBusy(null), false);
});

test("sameBytes compares tapes byte for byte", () => {
  assert.ok(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  assert.ok(sameBytes(new Uint8Array([1, 2, 3]), [1, 2, 3]));
  assert.ok(!sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
  assert.ok(!sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
  assert.ok(!sameBytes(null, new Uint8Array([1])));
  assert.ok(!sameBytes(new Uint8Array([1]), undefined));
  assert.ok(sameBytes(new Uint8Array([]), new Uint8Array([])));
});
