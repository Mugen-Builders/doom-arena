# Doom Arena

```
Cartesi Rollups Node version: 2.1.x
```

Doom Arena is a proof of concept that allows users to play the [riscv-binary port of Freedoom](https://github.com/rives-io/cartridge-freedoom) on a RISC-v Cartesi Machine on the browser, submit the game moves onchain so the session will be replayed in a Cartesi Rollups App to generate a provable score.

DISCLAIMERS

For now, this is not a final product and should not be used as one.

## Requirements

- [cartesapp](https://github.com/prototyp3-dev/cartesapp) to build, test, and execute the Cartesi Rollups node.
- [docker](https://docs.docker.com/) to execute the cartesapp sdk image that runs the cartesi rollups node and other tools.

## Instructions

Install Cartesapp:

```shell
python3 -m venv .venv
. .venv/bin/activate
pip3 install cartesapp[dev]@git+https://github.com/prototyp3-dev/cartesapp@v1.2.6
pip3 install pytest-randomly
```

### Run Devnet

You can run a cartesi rollups node on a local devnet with:

```shell
cartesapp node --log-level debug
```

This will generate the snapshot if it doesn't exist, and start the node.

Alternativelly, you can use the cartesi cli with the following commands:

```shell
npx -p @cartesi/cli@2.0.0-alpha.18 cartesi build
npx -p @cartesi/cli@2.0.0-alpha.18 cartesi run --block-time 1 --epoch-length 10 --project-name app --port 8080
```

### Run a PRT devnet with the rollups-node binaries (next/2.0)

The frontend targets rollups-node `next/2.0` (PR #798 shapes). To run it against a local PRT deployment with the native `cartesi-rollups-*` binaries (no containers), you need `anvil`/`cast` (Foundry) and a PostgreSQL:

```shell
# 1. L1: the Dave release ships an anvil state with every contract deployed
VER=3.0.0-alpha.5
curl -sSL https://github.com/cartesi/dave/releases/download/v${VER}/cartesi-rollups-prt-${VER}-anvil-1.5.1.tar.gz | tar xz -C /tmp
anvil --port 18545 --chain-id 31337 --block-time 1 --mixed-mining --load-state /tmp/state.json &
cat /tmp/deployments/31337/*.json | jq -s 'map({ (.contractName): .address }) | add'   # addresses below come from here

# 2. node database
export CARTESI_DATABASE_CONNECTION="postgres://postgres@127.0.0.1:5432/rollupsdb?sslmode=disable"
cartesi-rollups-cli db init

# 3. deploy the machine as a PRT application
export CARTESI_BLOCKCHAIN_HTTP_ENDPOINT=http://127.0.0.1:18545 CARTESI_BLOCKCHAIN_ID=31337
export CARTESI_CONTRACTS_INPUT_BOX_ADDRESS=0xEbE9f4Dfc04ae10bBeE663859c3dc5A23f94eA3C
export CARTESI_CONTRACTS_APPLICATION_FACTORY_ADDRESS=0x35Cd91f13141Bb6A6FC69E1eeDD241bbA1Ddd45F
export CARTESI_CONTRACTS_SELF_HOSTED_APPLICATION_FACTORY_ADDRESS=0x9e6866A965dC5f99f95EF6B0d8399dad18eEf98b
export CARTESI_CONTRACTS_AUTHORITY_FACTORY_ADDRESS=0xB4d29c86e36385b5321a453C34D288AEB0ad11f9
export CARTESI_CONTRACTS_QUORUM_FACTORY_ADDRESS=0x0754D5Eb680c71bf469B39e48C5b64AB0813fdb9
export CARTESI_CONTRACTS_DAVE_APP_FACTORY_ADDRESS=0xd34BEC37Fa5816ABA2f87BdaD2E13dd1B161370f
export CARTESI_AUTH_MNEMONIC="test test test test test test test test test test test junk"
export CARTESI_PRT_AUTH_MNEMONIC="$CARTESI_AUTH_MNEMONIC" CARTESI_PRT_AUTH_MNEMONIC_ACCOUNT_INDEX=6
cartesi-rollups-cli deploy application doom_arena .cartesi/image --prt --epoch-length 10 --claim-staging-period 30 --json

# 4. node — the CORS origin must be the site's exact origin
CARTESI_JSONRPC_CORS_ALLOWED_ORIGINS=http://localhost:3000 CARTESI_EVM_READER_POLLING_INTERVAL=1 cartesi-rollups-node -d latest
```

Then point `doom-arena-website/src/config.js` at `NODE_URL = "http://localhost:10011"`, `L1_RPC_URL = "http://127.0.0.1:18545"`, the application address printed by the deploy and the InputBox above, and run `npm run smoke -- http://localhost:10011 doom_arena 31337` before opening the site.

The gameplay fixtures in `tests/model.py` are tied to sender `0xdeadbeef7dc51b33c9a3e4a21ae053daa1872810`; on anvil you can submit them from that address with `cast rpc anvil_impersonateAccount <addr>`, `cast rpc anvil_setBalance <addr> 0x8AC7230489E80000` and `cast send --unlocked --from <addr> ...`.

### Running in Dev Mode

You'll be able to update the binaries and the snapshot will be updated. To generate the binaries run:

```shell
make -f src/Makefile build
```

Then run make the node in dev mode:

```shell
cartesapp node --log-level debug --dev --dev-watch-patterns='*' --dev-path='./src/dist' --drive-config app.builder=directory --drive-config app.directory=./src/dist
```

Any time you regenerate the binaries, it will rebuild its flash drive, replace it on the current snapshot of the machine, and force a reload on the app.

### Running the Testnet version

To run the node with the version that was deployed on testnet you should get the snapshot and run the node pointing to the testnet deployment. First, download the latest snapshot:

```shell
rm -rf .cartesi
mkdir -p .cartesi/image
DOOM_ARENA_VERSION=0.0.3
wget -qO- https://github.com/Mugen-Builders/doom-arena/releases/download/v${DOOM_ARENA_VERSION}/doom-arena-snapshot.tar.gz | tar zxf - -C .cartesi/image/
```

Then define the `CARTESI_AUTH_PRIVATE_KEY`, `RPC_URL`, and `RPC_WS` (additionally `APPLICATION_ADDRESS` and `CONSENSUS_ADDRESS`) environment variables. We suggest creating a .env.testnet file (and running `source .env.testnet`):

```shell
RPC_URL=
RPC_WS=
CARTESI_BLOCKCHAIN_ID=11155111
APPLICATION_ADDRESS=0x338709834f3A4255E4bF3DabA8d1eFCA6cBcA385
CONSENSUS_ADDRESS=0xE935fcf3236118C81d9D41592cB72f92a0336890
```

Finally run the following command to start the node:

```shell
cartesapp node --log-level debug \
  --config application_address=${APPLICATION_ADDRESS} --config consensus_address=${CONSENSUS_ADDRESS} \
  --config rpc_url=${RPC_URL} --config rpc_ws=${RPC_WS} --env=CARTESI_BLOCKCHAIN_ID=${CARTESI_BLOCKCHAIN_ID}\
  --env=CARTESI_BLOCKCHAIN_DEFAULT_BLOCK=finalized \
  --env=CARTESI_FEATURE_CLAIM_SUBMISSION_ENABLED=false
```

Some rpc providers may restrict the max range of blocks that can be queried. You can set this with `--env=CARTESI_BLOCKCHAIN_MAX_BLOCK_RANGE=<max_blocks>`.

Note: the application was deployed using the following command:

```shell
cartesapp deploy --log-level debug \
  --config application_address= --config consensus_address= \
  --config rpc_url=${RPC_URL} --config rpc_ws=${RPC_WS} \
  --env=CARTESI_AUTH_PRIVATE_KEY=${CARTESI_AUTH_PRIVATE_KEY}
```

## Interacting with Doom Arena

### Using the Web Frontend

You can use the web interface in the `doom-arena-website/` directory to play and submit gameplays directly from your browser.

The site targets **rollups-node `next/2.0`** (with the PR #798 JSON-RPC shapes: tournament/match/commitment `snapshot`s, no `data_availability`). It checks `cartesi_getNodeInfo` at startup and shows an "unsupported node" note against older nodes instead of half-working.

First, configure the constants in [doom-arena-website/src/config.js](doom-arena-website/src/config.js):

```javascript
// Network configuration
export const CHAIN_ID = "0x7a69"; // Local devnet chain ID (31337 in hex)

// Application contract address (from your node startup)
export const APPLICATION_ADDRESS = "0x6c060d453705bc56797d84516feb949c9bd53caa";

// Cartesi node URL (JSON-RPC at `${NODE_URL}/rpc`)
export const NODE_URL = "http://localhost:10011";

// InputBox address — cross-checked against what the node reports
export const INPUT_BOX_ADDRESS = "0x...";
```

`CHAIN_ID`, `APPLICATION_ADDRESS` and `INPUT_BOX_ADDRESS` are cross-checked against `cartesi_getNodeInfo` / `cartesi_getApplication`; on a mismatch the Rollup-state panel says so and submissions are disabled (a run sent to an InputBox the node does not watch is lost silently).

The node's JSON-RPC has **CORS disabled by default**, so the browser gets no answer unless the node allows the site's exact origin:

```shell
CARTESI_JSONRPC_CORS_ALLOWED_ORIGINS=http://localhost:3000 cartesi-rollups-node
```

Then build and serve the website:

```shell
cd doom-arena-website
npm install
npm run build
npm run dev
```

Access the frontend at `http://localhost:3000`.

Checks that do not need a browser:

```shell
npm test                                   # unit tests against the pinned rpc.discover fixture
npm run check:discover -- http://localhost:10011   # diff a live node's rpc.discover against the fixture
npm run smoke -- http://localhost:10011 doom_arena 31337   # live smoke against a running node
npm run smoke:browser                      # headless Chrome against a fake node (needs a Chrome binary)
```

### Using Rivemu

Alternatively, you can send Doom gameplay logs to the backend by generating a gameplay log with [Rivemu](https://github.com/rives-io/riv/releases/tag/v0.3-rc16).

#### Download Rivemu

Download the appropriate binary (adjust the platform and architecture variables):

```shell
PLATFORM=linux
ARCH=amd64
wget https://github.com/rives-io/riv/releases/download/v0.3-rc16/rivemu-${PLATFORM}-${ARCH} -O rivemu
chmod +x rivemu
```

Then you can play Freedoom with:

```shell
./rivemu cartridges/freedoom.sqfs
```

#### Submit the Gameplay

To submit the gameplay, you'll need to record the gameplay while playing the game. Additionally, to add security the backend requires the hash of the final outcard, and the entropy of the game will be tied to wallet that will submit the gameplay. With this in mind, you run the following command to generate a valid gameplay for submission (change the wallet address variable accordingly):

```shell
WALLET_ADDRESS=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
./rivemu -save-outhash=gameplay.outhash -record=gameplay.rivlog -entropy=${WALLET_ADDRESS} cartridges/freedoom.sqfs
```

This will generate a file called `gameplay.rivlog` with the gameplay logs and a file called `gameplay.outhash` with hash of the gameplay outcard.

Then you can submit the gameplay with the command next. We'll assume you are using the local devnet initiated on one of the previous steps (set the application address and blockchain configuration with the correct values):

```shell
INPUTBOX_ADDRESS=0x1b51e2992A2755Ba4D6F7094032DF91991a0Cfac
APPLICATION_ADDRESS=0x6c060d453705bc56797d84516feb949c9bd53caa
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cast send --private-key ${PRIVATE_KEY} ${INPUTBOX_ADDRESS} "addInput(address,bytes)" ${APPLICATION_ADDRESS} 0x$(cat gameplay.outhash)$(xxd -p -c10000 gameplay.rivlog)
```

Note: if you are using the cartesi cli, you should add the `--rpc-url` pointing to cli's devnet `--rpc-url http://localhost:8080/anvil` and set the `APPLICATION_ADDRESS` with the value after you started the Node (the `cartesi run ...` command).

#### Get the Outputs

You can get the outputs with the commands defined next. We'll assume you are using the local devnet initiated on one of the previous steps (set the application address and blockchain configuration with the correct values). You'll need `curl`, `jq`, `xxd` tools.

The leaderboard notices are the outputs whose selector is `Notice(bytes)`; the node filters them server-side with `output_type`, and `descending` returns the newest first (the default is oldest first):

```shell
RPC_URL=http://localhost:10011/rpc
curl -s ${RPC_URL} -d '{
  "jsonrpc": "2.0",
  "method": "cartesi_listOutputs",
  "params": {
    "application": "app",
    "output_type": ["0xc258d6e5"],
    "descending": true,
    "limit": 100
  },
  "id": 1
}' | jq -r '.result.data[].decoded_data.payload'
```

You can also get the reports which will contain the errors:

```shell
RPC_URL=http://localhost:10011/rpc
curl -s ${RPC_URL} -d '{
  "jsonrpc": "2.0",
  "method": "cartesi_listReports",
  "params": {
    "application": "app"
  },
  "id": 1
}' | jq -r '.result.data[].raw_data' | xxd -p -r
```

And the node's own identity (chain id, version, and the block tag it reads the chain at):

```shell
curl -s ${RPC_URL} -d '{"jsonrpc":"2.0","method":"cartesi_getNodeInfo","params":[],"id":1}' | jq .result.data
```

Error codes on this node generation: `-31001` resource not found (e.g. no accepted epoch yet — safe to poll), `-31002` application not found (a configuration error), `-31003` response over the 10 MB budget, `-32070` timeout; `-32601`/`-32602`/`-32603` follow JSON-RPC 2.0.

## Run the Tests

To run the tests:

```shell
cartesapp test --cartesi-machine --log-level debug
```

## Cartesi Machine Shell

You can run the cartesi shell with:

```shell
cartesapp shell --log-level debug --drive-config app.builder=volume --drive-config app.directory=./src/dist
```
