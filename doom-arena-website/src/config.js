// Emulator configuration
export const EMULATOR_URL = "https://emulator.rives.io";
export const CARTRIDGES_URL =
  "https://raw.githubusercontent.com/lynoferraz/rives-barebones-doom/main/cartridges/freedoom.sqfs";

// Network configuration
export const CHAIN_ID = "0x7A69"; // anvil devnet
// export const CHAIN_ID = "0xaa36a7"; // sepolia
// export const CHAIN_ID = "0x14a34"; // base sepolia

// Application contract address
// export const APPLICATION_ADDRESS = "0x51bb5ee19f3248e5b19ee7d5229c101fdf5861ff"; // blank
// export const APPLICATION_ADDRESS = "0xcf6c7533bdf31ba00eb16e1c9aec95a3d8992e63"; // cartesapp
export const APPLICATION_ADDRESS = "0xAD99e7c1c9bb884c7fa97d15E7fEDCeA04586abe"; // cartesi-bin
// export const APPLICATION_ADDRESS = "0x90557BEd8755d2bB1b943e6f151267d7a219B90C"; // salt 1
// export const APPLICATION_ADDRESS = ""; // Cartesapp blank Deployment
// export const APPLICATION_ADDRESS = "0x338709834f3A4255E4bF3DabA8d1eFCA6cBcA385"; // sepolia
// export const APPLICATION_ADDRESS = "0xaef8aebc5a325079dd4d1ae41ac525c47dc1d9e4"; // base sepolia

// Cartesi node URL
export const NODE_URL = "http://localhost:8080";
// export const NODE_URL = "http://127.0.0.1:6751";
// export const NODE_URL = "https://doom-sepolia-bare.rives.io"; // rives infra
// export const NODE_URL = "https://base-sepolia.rollups.cartesi.io/v2"; // cartesi cloud infra

// Cartesi InputBox contract address (constant across deployments)
export const INPUT_BOX_ADDRESS = "0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac";

// <script>
//   window.__ARENA_CONFIG = {
//     NODE_URL: "https://base-sepolia.rollups.cartesi.io/v2",
//     RPC_URL: "https://base-sepolia.rollups.cartesi.io/v2/rpc",
//     APPLICATION_ADDRESS: "0xA18dC0a420aB4504e36666a65F4387574cBd80C0",
//     INPUT_BOX_ADDRESS: "0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac",
//     CHAIN_ID: 84532,
//     EMULATOR_URL: "https://emulator.rives.io",
//     CARTRIDGES_URL: "https://raw.githubusercontent.com/lynoferraz/rives-barebones-doom/main/cartridges/freedoom.sqfs",
//     // Emulator letterbox color (HSLA) — matches the page background #0a0908
//     BG_HUE: 30,
//     BG_SAT: 11,
//     BG_LIGHT: 4,
//     BG_ALPHA: 1
//   };
// </script>
