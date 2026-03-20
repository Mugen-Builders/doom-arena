// External imports
import {
  type Hex,
  toHex,
  isHex,
  decodeAbiParameters,
  parseAbiParameters,
  WalletClient,
  toBytes,
} from "viem";
import { Output } from "@cartesi/viem";

// Local imports
import {
  APPLICATION_ADDRESS,
  CARTRIDGES_URL,
  CHAIN_ID,
  EMULATOR_URL,
  NODE_URL,
} from "./consts.js";
import {
  connectWalletClient,
  submitGameplay,
  validateGameplay,
  type Proof,
} from "./lib/onchain.js";
import { getL2Client } from "./utils/chain.js";

interface EmulatorParams {
  simple?: boolean;
  autoplay?: boolean;
  tapeUrl?: string;
  args?: string;
  incardUrl?: string;
  entropy?: string;
  extra?: string;
}

interface VerificationNotice {
  user: string;
  timestamp: bigint;
  score: bigint;
  input_index: bigint;
  payload?: `0x${string}`;
  proof?: Proof | null;
}

type RpcFilter = {
  limit?: number;
  offset?: number;
  epochIndex?: bigint;
  inputIndex?: bigint;
  outputType?: "DelegateCallVoucher" | "Notice" | "Voucher";
  voucherAddress?: `0x${string}`;
};

async function getOutputs(
  appAddress: string,
  nodeAddress: string,
  filter?: RpcFilter,
): Promise<Output[]> {
  if (!nodeAddress) return [];
  const client = await getL2Client(nodeAddress + "/rpc");
  if (!client) return [];
  const outputResponse = await client.listOutputs({
    ...filter,
    application: appAddress,
  });
  return outputResponse.data;
}

async function getInput(
  appAddress: string,
  nodeAddress: string,
  inputIndex: bigint,
  filter?: RpcFilter,
): Promise<Uint8Array> {
  if (!nodeAddress) return new Uint8Array([]);
  const client = await getL2Client(nodeAddress + "/rpc");
  if (!client) return new Uint8Array([]);
  const inputResponse = await client.getInput({
    ...filter,
    application: appAddress,
    inputIndex,
  });
  return toBytes(inputResponse.decodedData.payload);
}

function decodeVerificationNotice(output: Output): VerificationNotice | null {
  try {
    // Only process notices for leaderboard data
    const decodedData = output.decodedData as Record<string, unknown>;
    const type: string =
      decodedData && decodedData.type ? (decodedData.type as string) : "";

    if (type.toLowerCase() !== "notice") {
      return null;
    }

    const payload =
      decodedData && decodedData.payload ? (decodedData.payload as string) : "";

    if (!isHex(payload)) {
      return null;
    }

    // Try to decode as verification notice
    const decoded = decodeAbiParameters(
      parseAbiParameters(
        "address user, uint256 timestamp, int256 score, uint256 input_index",
      ),
      payload as `0x${string}`,
    );

    return {
      user: decoded[0] as string,
      timestamp: decoded[1] as bigint,
      score: decoded[2] as bigint,
      input_index: decoded[3] as bigint,
      payload: output.rawData,
      proof: output.outputHashesSiblings
        ? {
            outputIndex: output.index,
            outputHashesSiblings: output.outputHashesSiblings,
          }
        : null,
    };
  } catch (error) {
    // Not a verification notice or invalid format
    return null;
  }
}

/**
 * Sets the emulator iframe URL with the provided parameters
 * @param params - Configuration parameters for the emulator
 */
export function setEmulatorUrl(params: EmulatorParams): void {
  try {
    if (!params || typeof params !== "object") {
      console.error("Invalid emulator parameters");
      return;
    }

    const emulator = document.getElementById("emulator-iframe");
    if (!emulator || !(emulator instanceof HTMLIFrameElement)) {
      console.error("Emulator iframe not found");
      return;
    }

    if (!EMULATOR_URL) {
      console.error("Emulator URL not configured");
      return;
    }

    let fullSrc = `${EMULATOR_URL}/#`;

    fullSrc += `&cartridge=${CARTRIDGES_URL}`;

    if (params.tapeUrl !== undefined) {
      fullSrc += `&tape=${params.tapeUrl}`;
    }

    if (params.simple !== undefined) {
      fullSrc += `&simple=${params.simple}`;
    }

    if (params.autoplay !== undefined) {
      fullSrc += `&autoplay=${params.autoplay}`;
    }

    if (params.entropy) {
      fullSrc += `&entropy=${encodeURIComponent(params.entropy)}`;
    }

    if (params.extra) {
      fullSrc += `&${params.extra}`;
    }

    emulator.src = fullSrc;
  } catch (error) {
    console.error("Error setting emulator URL:", error);
  }
}

interface WalletConnection {
  client: WalletClient | null;
  address: string | null;
}

async function getConnectedClient(): Promise<WalletConnection> {
  const msgDiv = document.getElementById("connect-msg");
  const submitMsgDiv = document.getElementById("submit-msg");

  if (submitMsgDiv) {
    submitMsgDiv.innerHTML = "";
  }

  try {
    const currClient = await connectWalletClient(CHAIN_ID);
    if (!currClient) {
      throw new Error("Error connecting wallet");
    }

    const [address] = await currClient.requestAddresses();
    if (msgDiv) {
      const shortAddress = `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
      msgDiv.innerHTML = `Connected with ${shortAddress} on ${currClient.chain.name}`;
    }

    return { client: currClient, address: address };
  } catch (error) {
    console.error(error);
    if (msgDiv) {
      let msg = "Error connecting wallet";
      if (error instanceof Error) {
        const dotIndex = error.message.indexOf(".");
        msg =
          dotIndex >= 0 ? error.message.substring(0, dotIndex) : error.message;
      }
      msgDiv.innerHTML = `${msg} (Demo Version)`;
    }
    setEmulatorUrl({ simple: true });
    return { client: null, address: null };
  }
}

interface GameplayParams {
  rivemuOnFinish: boolean;
  outhash: string;
  tape: string;
}

async function handleGameplaySubmission(
  client: WalletClient,
  params: GameplayParams,
): Promise<void> {
  const submitMsgDiv = document.getElementById("submit-msg");
  if (submitMsgDiv) {
    submitMsgDiv.innerHTML = "";
  }

  const gameplayPayload = `0x${params.outhash}${toHex(params.tape).slice(2)}`;

  if (!isHex(gameplayPayload)) {
    if (submitMsgDiv) {
      submitMsgDiv.innerHTML = "Error: Invalid payload format";
    }
    return;
  }

  try {
    await submitGameplay(client, gameplayPayload as `0x${string}`);
    if (submitMsgDiv) {
      submitMsgDiv.innerHTML = "Gameplay submitted";
    }
  } catch (error) {
    console.error(error);
    if (submitMsgDiv) {
      let msg = "Error submitting";
      if (error instanceof Error) {
        const dotIndex = error.message.indexOf(".");
        msg =
          dotIndex >= 0 ? error.message.substring(0, dotIndex) : error.message;
      }
      submitMsgDiv.innerHTML = msg;
    }
  }
}

/**
 * Sets up wallet connection and gameplay submission functionality
 */
export async function setupSubmit(): Promise<void> {
  // connection vars
  let client: WalletClient | null;
  let userAddress: string | null;

  const updateWalletConnection = async (): Promise<void> => {
    const connectedClient = await getConnectedClient();
    client = connectedClient.client;
    userAddress = connectedClient.address;
  };

  // Set wallet event listeners
  if (window.ethereum) {
    window.ethereum.on("chainChanged", updateWalletConnection);
    window.ethereum.on("accountsChanged", updateWalletConnection);
  }

  // get connected wallet
  const connectedClient = await getConnectedClient();
  client = connectedClient.client;
  userAddress = connectedClient.address;

  if (!client || !userAddress) {
    return;
  }

  // set submit listener
  window.addEventListener(
    "message",
    (e) => {
      if (!client || !userAddress) return;
      const params = e.data;
      if (params.rivemuOnFinish) {
        handleGameplaySubmission(client, params);
      }
    },
    false,
  );

  // set entropy and config emulator
  const entropy = userAddress.toLowerCase();
  setEmulatorUrl({
    simple: true,
    entropy: entropy,
  });
}

function populateLeaderboardTable(
  table: HTMLTableElement,
  notices: VerificationNotice[],
): void {
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }

  let rank = 1;
  for (const notice of notices) {
    const row = table.insertRow();
    let user: string = "Unknown";
    if (notice.user !== undefined) {
      user = `${notice.user.slice(0, 6)}...${notice.user.substring(notice.user.length - 4, notice.user.length)}`;
      if (notice.input_index !== undefined) {
        const replayUrl = `./replay?user=${notice.user}&input_index=${notice.input_index}`;
        row.setAttribute("data-href", replayUrl);
        row.addEventListener("click", function () {
          const href = this.dataset.href;
          if (href) {
            window.location.href = href;
          }
        });
      }
    }
    row.insertCell().innerHTML = `${rank++}`;
    row.insertCell().innerHTML = user;
    row.insertCell().innerHTML = formatDate(
      new Date(Number(notice.timestamp) * 1000),
    );
    row.insertCell().innerHTML = `${notice.score}`;
    const msgCellId = `leaderboard-score-${notice.input_index}`;
    // row.insertCell().innerHTML = `${notice.input_index}`;
    const actionCell = row.insertCell();
    actionCell.innerHTML = "check";
    actionCell.className = "leaderboardButton";
    actionCell.onclick = (event) => {
      event.stopPropagation();
      validateScore(msgCellId, notice.payload, notice.proof);
    };
    row.insertCell().id = msgCellId;
  }
}

export async function validateScore(
  cellId: string,
  payload?: `0x${string}`,
  proof?: Proof,
) {
  const el = document.getElementById(cellId);
  if (el) {
    el.innerHTML = "Validating...";
    try {
      if (await validateGameplay(payload, proof)) {
        el.innerHTML = "✅"; //"&#9989;"; // "&#9745;";
      } else {
        el.innerHTML = "✖"; //"&amp;#10060;";
      }
    } catch (e) {
      el.innerHTML = `❌ ${e}`; // "&amp;#10005;"
    }
  }
}

/**
 * Renders the leaderboard table with verification notices from the Cartesi node
 */
export async function renderLeaderboard(): Promise<void> {
  const table = document.getElementById("leaderboard");
  if (!table || !(table instanceof HTMLTableElement)) {
    console.error("Leaderboard table not found");
    return;
  }

  try {
    if (!APPLICATION_ADDRESS || !NODE_URL) {
      throw new Error("Missing application address or node URL configuration");
    }

    // Fetch all outputs from Cartesi
    const outputs = await getOutputs(APPLICATION_ADDRESS, NODE_URL);

    if (!Array.isArray(outputs)) {
      throw new Error("Invalid outputs received from node");
    }

    // Decode verification notices
    const verificationNotices: VerificationNotice[] = [];
    for (const output of outputs) {
      try {
        const notice = decodeVerificationNotice(output);
        if (notice) {
          verificationNotices.push(notice);
        }
      } catch (decodeError) {
        console.warn("Failed to decode output:", decodeError);
        // Continue processing other outputs
      }
    }

    // Sort by score (descending) and then by timestamp (ascending for earliest)
    verificationNotices.sort((a, b) => {
      const scoreDiff = Number(b.score - a.score);
      if (scoreDiff !== 0) return scoreDiff;
      return Number(a.timestamp - b.timestamp);
    });

    if (verificationNotices.length === 0) {
      while (table.rows.length > 1) {
        table.deleteRow(1);
      }
      const row = table.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 7;
      cell.innerHTML = "No leaderboard data available";
      return;
    }

    // Populate table with leaderboard data
    populateLeaderboardTable(table, verificationNotices);
  } catch (error) {
    console.error("Error rendering leaderboard:", error);
    while (table.rows.length > 1) {
      table.deleteRow(1);
    }
    const row = table.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.innerHTML = "Error loading leaderboard data";
  }
}

/**
 * Formats a Date object to a readable string
 * @param date - Date object to format
 * @returns Formatted date string
 */
function formatDate(date: Date): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  };

  const dateString = date.toLocaleDateString("en-US", options);
  const [month_day, year, time] = dateString.split(",");
  const [month, day] = month_day.split(" ");
  const finalYear = year.substring(1);

  return `${month}/${day}/${finalYear}, ${time}`;
}

export async function setupReplay(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const user = params.get("user");
  const inputIndex = params.get("input_index");

  if (!inputIndex) {
    console.error("No input_index provided");
    return;
  }

  try {
    const inputData = await getInput(
      APPLICATION_ADDRESS,
      NODE_URL,
      BigInt(inputIndex),
    );
    const tape = inputData.slice(32);

    setEmulatorUrl({});

    const handleUploadedEvent = (e: MessageEvent) => {
      const eventData = e.data;
      if (eventData?.rivemuUploaded) {
        const emulator = document.getElementById("emulator-iframe");
        if (emulator instanceof HTMLIFrameElement && emulator.contentWindow) {
          emulator.contentWindow.postMessage(
            {
              rivemuUpload: true,
              tape,
              autoPlay: true,
              entropy: user?.toLowerCase(),
            },
            "*",
          );
        }
        window.removeEventListener("message", handleUploadedEvent, false);
      }
    };

    window.addEventListener("message", handleUploadedEvent, false);
  } catch (error) {
    console.error("Error setting up replay:", error);
  }
}
