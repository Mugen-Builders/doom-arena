// Emulator configuration
export const EMULATOR_URL = "https://emulator.rives.io";
export const CARTRIDGES_URL =
  "https://raw.githubusercontent.com/lynoferraz/rives-barebones-doom/main/cartridges/freedoom.sqfs";

// Network configuration
export const CHAIN_ID = "0x7A69"; // anvil devnet
// export const CHAIN_ID = "0xaa36a7"; // sepolia
// export const CHAIN_ID = "0x14a34"; // base sepolia

// Application contract address
// export const APPLICATION_ADDRESS = "0x3a53856a1440ac887721501d2d13a6c82b7310c0"; // blank
// export const APPLICATION_ADDRESS = "0xc50e72fEdFD01973A17489F92e8fa20AfBf6e323"; // cartesapp
export const APPLICATION_ADDRESS = "0x8f0119224ed78f4b5eab03c9ab7f9876ad760288"; // cartesi-bin
// export const APPLICATION_ADDRESS = "0xA617f08B95EfdD5496E22F1FE7e378280dF5b831"; // base sepolia

// Cartesi node URL (JSON-RPC is served at `${NODE_URL}/rpc`).
// Requires rollups-node `next/2.0` with PR #798 shapes; the site checks
// cartesi_getNodeInfo at startup and refuses older nodes. Browsers only get an
// answer when the node allows this site's exact origin:
//   CARTESI_JSONRPC_CORS_ALLOWED_ORIGINS=http://localhost:3000
// (CORS is off by default; wildcard is not supported.)
// export const NODE_URL = "http://localhost:8080";
export const NODE_URL = "http://localhost:6752";
// export const NODE_URL = "https://doom-sepolia-bare.rives.io"; // rives infra
// export const NODE_URL = "https://base-sepolia.rollups.cartesi.io/v2"; // cartesi cloud infra

// Cartesi InputBox contract address
// NOTE: not constant across deployments or contract releases. The site
// cross-checks this, CHAIN_ID and APPLICATION_ADDRESS against what the node
// reports (cartesi_getNodeInfo / cartesi_getApplication) and, on a mismatch,
// shows it in the Rollup-state panel and disables submissions rather than
// sending runs to an InputBox the node is not watching.
export const INPUT_BOX_ADDRESS = "0xEbE9f4Dfc04ae10bBeE663859c3dc5A23f94eA3C";

// Application name as registered on the node. When set it is used instead of
// APPLICATION_ADDRESS for node RPC lookups (the node resolves either).
export const APPLICATION_NAME = "";
// export const APPLICATION_NAME = "doom_arena"; // cartesi cloud infra

// L1 JSON-RPC endpoint for contract reads (PRT tournament state, validateOutput)
// and for the submit path's simulate + gas estimate (see src/submit.js), so on
// Base Sepolia set it rather than relying on the wallet's RPC.
// Leave empty to use the chain's default public RPC — fine for anvil, but Base
// Sepolia's default will rate-limit once tournament reads are polling.
// This is baked into the published bundle, so use a domain-restricted or
// keyless endpoint, never a secret one.
export const L1_RPC_URL = "http://localhost:6752/anvil";
