import {
  createPublicClient,
  http,
  fromHex,
  WalletClient,
  parseAbi,
} from "viem";
import { getWalletClient, getChain } from "../utils/chain.js";
import { APPLICATION_ADDRESS, INPUT_BOX_ADDRESS } from "../consts.js";

export interface Proof {
  outputIndex: bigint;
  outputHashesSiblings: `0x${string}`[];
}

const inputBoxAbi = parseAbi([
  "function addInput(address _app, bytes payload) payable",
]);

export async function connectWalletClient(chainId: number | string) {
  const chainIdNumber =
    typeof chainId === "string"
      ? fromHex(chainId as `0x${string}`, "number")
      : chainId;
  return await getWalletClient(chainIdNumber);
}

export async function submitGameplay(
  walletClient: WalletClient,
  payload: `0x${string}`,
): Promise<void> {
  if (!payload.startsWith("0x") || payload.length <= 2) {
    throw new Error("Invalid payload format");
  }
  if (!walletClient || !walletClient.chain) {
    throw new Error("No connected wallet");
  }

  if (!window.ethereum) {
    throw new Error("Ethereum provider not available");
  }

  const chainIdHex = (await window.ethereum.request({
    method: "eth_chainId",
  })) as `0x${string}`;
  const currentChainId = fromHex(chainIdHex, "number");

  if (currentChainId !== walletClient.chain.id) {
    throw new Error(
      `Wrong network, please switch to ${walletClient.chain.name}`,
    );
  }

  const publicClient = createPublicClient({
    chain: walletClient.chain,
    transport: http(),
  });

  const [address] = await walletClient.requestAddresses();

  const { request } = await publicClient.simulateContract({
    account: address,
    address: INPUT_BOX_ADDRESS,
    abi: inputBoxAbi,
    functionName: "addInput",
    args: [APPLICATION_ADDRESS, payload],
    value: BigInt(0),
  });

  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
}

export async function validateGameplay(
  payload?: `0x${string}`,
  proof?: Proof | null,
): Promise<boolean> {
  if (!payload || !payload.startsWith("0x") || payload.length <= 2) {
    throw new Error("No payload");
  }
  if (!proof) {
    throw new Error("No proof");
  }

  if (!window.ethereum) {
    throw new Error("Ethereum provider not available");
  }

  const chainIdHex = (await window.ethereum.request({
    method: "eth_chainId",
  })) as `0x${string}`;
  const currentChainId = fromHex(chainIdHex, "number");
  const chain = getChain(currentChainId);
  if (!chain) {
    throw new Error("Couldn't get chain");
  }

  try {
    const publicClient = createPublicClient({
      chain: chain,
      transport: http(),
    });
    const args = [payload, [proof.outputIndex, proof.outputHashesSiblings]];
    await publicClient.readContract({
      address: APPLICATION_ADDRESS,
      abi: parseAbi([
        "function validateOutput(bytes,(uint64,bytes32[])) view",
        "error InvalidOutputHashesSiblingsArrayLength()",
        "error InvalidOutputsMerkleRoot(bytes32 outputsMerkleRoot)",
      ]),
      functionName: "validateOutput",
      args: args,
    });
  } catch (e) {
    console.warn("Failed to validate notice", e);
    return false;
  }
  return true;
}
