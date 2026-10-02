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
