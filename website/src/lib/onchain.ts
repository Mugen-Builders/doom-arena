import {
  createPublicClient,
  http,
  fromHex,
  WalletClient,
  parseAbi,
} from "viem";
import { getWalletClient } from "../utils/chain.js";
import { APPLICATION_ADDRESS, INPUT_BOX_ADDRESS } from "../consts.js";

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
