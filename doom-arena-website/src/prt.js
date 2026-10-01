// =============================================================
// PRT / Dave consensus — status reads
// =============================================================
// Since rollups-node PR #798 the node indexes both the *structure* of a
// dispute (tournaments, commitments, matches and how they ended) and a
// *snapshot* of live contract state read at a stated block: tournament
// standing, match phase and bisection frontier, commitment clocks. The panel
// is built from those snapshots.
//
//   node RPC  -> epochs, tournament tree, commitments, matches, snapshots
//   eth_call  -> the staged-claim sentry state only (the one live fact the
//                node does not index): canAcceptStagedTournamentResult plus
//                the sentry claim counters
//
// Snapshots are taken at the node's default block (FINALIZED on Base means a
// few minutes behind). `asOfBlock` is exposed so the UI can say so.
//
// Dave contracts: the node pins 3.0.0-alpha.5, whose IDaveConsensus read
// surface is identical to alpha.4 for the function used here.
// =============================================================

import { parseAbi } from "viem";

// -------------------------------------------------------------
// ABI — IDaveConsensus, Dave v3.0.0-alpha.5
// Verified against cartesi-rollups-prt-3.0.0-alpha.5-contract-artifacts.
// -------------------------------------------------------------
export const daveConsensusAbi = parseAbi([
  "function getCurrentSealedEpoch() view returns (uint256 epochNumber, uint256 inputIndexLowerBound, uint256 inputIndexUpperBound, address tournament, bool isTournamentResultStaged, uint256 stagingBlockNumber, bytes32 stagedPostEpochMachineStateHash, bytes32 stagedPostEpochOutputsMerkleRoot)",
  "function canStageTournamentResult() view returns (bool isFinished, bool isTournamentFailed, bool isTournamentResultStaged, uint256 epochNumber, bytes32 winnerCommitment, bytes32 winnerPostEpochMachineStateHash)",
  "function canAcceptStagedTournamentResult() view returns (bool isTournamentResultStaged, bool doAllSentriesAgreeWithStagedTournamentResult, bool isClaimStagingPeriodOver, uint256 epochNumber, bytes32 stagedPostEpochMachineStateHash, bytes32 stagedPostEpochOutputsMerkleRoot)",
  "function getClaimStagingPeriod() view returns (uint256)",
  "function getNumberOfSentries() view returns (uint256)",
  "function getSentryClaimCount(uint256 epochNumber, bytes32 postEpochMachineStateHash) view returns (uint256)",
  "function hasSentryClaimedInEpoch(uint256 epochNumber, uint256 sentryId) view returns (bool)",
]);

// `doAllSentriesAgreeWithStagedTournamentResult` is the contract's FAST PATH:
// true only when every sentry has claimed the staged hash, which lets the
// result be accepted before the staging period ends. It is false with zero
// sentries and while sentries have not claimed yet — it does NOT mean a sentry
// disagrees. Dissent is derived from the claim counters instead: a sentry
// that claimed in the epoch but not for the staged hash claimed another one.

// -------------------------------------------------------------
// Enum / status maps
//
// Keys are the node's enum members (rpc.discover, pinned in
// test/fixtures/jsonrpc-discover.json). `tone` must name a real
// .status-<tone> rule in arena.css.
// -------------------------------------------------------------
export const EPOCH_STATUS = {
  OPEN: { label: "OPEN", tone: "open" },
  CLOSED: { label: "CLOSED", tone: "pending" },
  INPUTS_PROCESSED: { label: "COMPUTING", tone: "pending" },
  CLAIM_COMPUTED: { label: "CLAIM COMPUTED", tone: "pending" },
  CLAIM_SUBMITTED: { label: "IN TOURNAMENT", tone: "pending" },
  CLAIM_STAGED: { label: "STAGED", tone: "pending" },
  CLAIM_ACCEPTED: { label: "ACCEPTED", tone: "ok" },
  CLAIM_REJECTED: { label: "REJECTED", tone: "bad" },
  CLAIM_FORECLOSED: { label: "FORECLOSED", tone: "bad" },
};

// Terminal statuses never regress (node docs), so a settled epoch needs no
// live tracking.
export const TERMINAL_EPOCH_STATUS = [
  "CLAIM_ACCEPTED",
  "CLAIM_REJECTED",
  "CLAIM_FORECLOSED",
];

// The epoch consensus is actually working on is the *oldest* one that has
// left OPEN and not yet settled. Under PRT this is where the tournament lives;
// the newest epoch is merely collecting inputs.
export const NON_TERMINAL_PAST_OPEN = [
  "CLOSED",
  "INPUTS_PROCESSED",
  "CLAIM_COMPUTED",
  "CLAIM_SUBMITTED",
  "CLAIM_STAGED",
];

// An unknown status must stay legible rather than render as raw unstyled text.
export function epochStatus(epoch) {
  const raw = (epoch?.status ?? "").toString();
  return (
    EPOCH_STATUS[raw.toUpperCase()] ?? {
      label: raw ? raw.replace(/_/g, " ").toUpperCase() : "—",
      tone: "pending",
    }
  );
}

export const isSettled = (epoch) =>
  TERMINAL_EPOCH_STATUS.includes(String(epoch?.status ?? "").toUpperCase());

// TournamentStandingState
export const TOURNAMENT_STANDING = {
  MATCHES_ACTIVE: { label: "DISPUTE ACTIVE", tone: "bad" },
  AWAITING_CLOSURE: { label: "AWAITING CLOSURE", tone: "pending" },
  ROOT_WINNER: { label: "SETTLED", tone: "ok" },
  ROOT_FAILED: { label: "FAILED — NO WINNER", tone: "bad" },
  INNER_WINNER: { label: "INNER WINNER", tone: "ok" },
  INNER_ELIMINABLE_NO_WINNER: { label: "ELIMINABLE", tone: "bad" },
  INNER_ELIMINABLE_WINNER_EXPIRED: { label: "ELIMINABLE", tone: "bad" },
};

export const standingOf = (key) => {
  const k = String(key ?? "").toUpperCase();
  const s = TOURNAMENT_STANDING[k];
  return s
    ? { key: k, ...s }
    : { key: k ? `UNKNOWN_${k}` : "UNKNOWN", label: "UNKNOWN", tone: "pending" };
};

export const MATCH_PHASE = [
  "UNINITIALIZED",
  "BISECTING",
  "READY_TO_SEAL",
  "SEALED",
];

export const COMMITMENT_SIDE = ["ONE", "TWO"];

// MatchTimeoutOutcome — what the timeout classifier says would happen if the
// clock ran out now. NONE means nobody is out of time.
export const TIMEOUT_OUTCOME = {
  NONE: null,
  ONE_WINS: "ONE can win by timeout",
  TWO_WINS: "TWO can win by timeout",
  ELIMINATE_BOTH: "both eliminable",
};

// MatchDeletionReason. NOT_DELETED is the node's own marker for a match that
// is still live; it is not an on-chain enum member.
export const DELETION_REASON = {
  NOT_DELETED: "active",
  STEP: "proven wrong by step",
  TIMEOUT: "timed out",
  CHILD_TOURNAMENT: "decided by inner tournament",
};

export const isMatchActive = (m) =>
  !m?.deletionReason || m.deletionReason === "NOT_DELETED";

// -------------------------------------------------------------
// helpers
// -------------------------------------------------------------

// A failed read yields null for that one field instead of taking down the
// whole panel.
const safe = (p) => Promise.resolve(p).then((v) => v, () => null);

const rows = (r) => (Array.isArray(r) ? r : (r?.data ?? []));
const totalCount = (r) => Number(r?.pagination?.totalCount ?? rows(r).length);

const maxBig = (values) =>
  values.reduce((m, v) => (v != null && (m == null || v > m) ? v : m), null);

// -------------------------------------------------------------
// tree
// -------------------------------------------------------------

// listTournaments returns a flat list; parentTournamentAddress links them.
// A malformed or partial list must not hang the render, so anything that does
// not reach a root is appended as an orphan rather than dropped.
export function buildTournamentTree(tournaments) {
  const nodes = tournaments.map((t) => ({ ...t, children: [] }));
  const byAddr = new Map(nodes.map((n) => [n.address.toLowerCase(), n]));
  const roots = [];
  for (const n of nodes) {
    const parent = n.parentTournamentAddress
      ? byAddr.get(n.parentTournamentAddress.toLowerCase())
      : null;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  const seen = new Set();
  const order = [];
  const walk = (n, depth) => {
    if (seen.has(n)) return;
    seen.add(n);
    order.push({ node: n, depth });
    n.children
      .sort((a, b) => Number(a.level) - Number(b.level))
      .forEach((c) => walk(c, depth + 1));
  };
  roots
    .sort((a, b) => Number(a.level) - Number(b.level))
    .forEach((r) => walk(r, 0));
  for (const n of nodes) if (!seen.has(n)) order.push({ node: n, depth: 0 });
  return { roots, order };
}

// -------------------------------------------------------------
// main fetch
// -------------------------------------------------------------

/**
 * Collect PRT status for one epoch: three node list calls, one eth_call for a
 * staged claim, and one eth_blockNumber when an L1 client is available.
 *
 * Never throws: every read is individually guarded.
 */
export async function fetchPrtState({
  nodeClient,
  l1Client,
  application,
  consensusAddress,
  epoch,
  claimStagingPeriod,
}) {
  const out = {
    epochIndex: epoch?.index ?? null,
    consensusAddress: consensusAddress ?? null,
    tournaments: [],
    order: [],
    root: null,
    matches: [],
    commitments: [],
    commitmentCount: 0,
    matchCount: 0,
    activeMatchCount: 0,
    disputed: false,
    staging: null,
    currentBlock: null,
    asOfBlock: null, // block the node's snapshots were read at
    snapshotOk: null, // false when tournaments exist without snapshots
  };
  if (!epoch || !nodeClient) return out;

  const epochIndex = epoch.index;

  // Counts come from pagination.totalCount and stay exact; only the rendered
  // detail truncates at 50, which no realistic dispute on this app reaches.
  const [tournamentsR, commitmentsR, matchesR] = await Promise.all([
    safe(nodeClient.listTournaments({ application, epochIndex, limit: 50 })),
    safe(nodeClient.listCommitments({ application, epochIndex, limit: 50 })),
    safe(nodeClient.listMatches({ application, epochIndex, limit: 50 })),
  ]);

  out.tournaments = rows(tournamentsR);
  out.commitments = rows(commitmentsR);
  out.commitmentCount = totalCount(commitmentsR);
  out.matches = rows(matchesR).map((m) => ({ ...m }));
  out.matchCount = totalCount(matchesR);
  out.activeMatchCount = out.matches.filter(isMatchActive).length;

  // More than one commitment means validators disagreed on the post-epoch
  // state; a match is the tournament pairing them off. Either is a dispute.
  out.disputed = out.commitmentCount > 1 || out.matchCount > 0;

  const { roots, order } = buildTournamentTree(out.tournaments);
  out.order = order;
  for (const { node } of order) {
    const s = node.snapshot;
    node.standing = s ? standingOf(s.standing) : null;
    node.acceptsJoins = s?.acceptsJoins ?? null;
    node.candidate = s?.candidate ?? null;
    node.winnerCommitment = s?.winnerCommitment ?? null;
    node.finishedAtBlock = s?.finishedAtBlock ?? null;
  }
  out.root =
    roots.find((r) => Number(r.level) === 0) ??
    roots[0] ??
    (epoch.tournamentAddress
      ? { address: epoch.tournamentAddress, level: 0n, children: [], standing: null }
      : null);

  if (out.tournaments.length)
    out.snapshotOk = out.tournaments.every((t) => t.snapshot != null);

  out.asOfBlock = maxBig([
    ...out.tournaments.map((t) => t.snapshot?.asOfBlock),
    ...out.matches.map((m) => m.snapshot?.asOfBlock),
    ...out.commitments.map((c) => c.snapshot?.asOfBlock),
  ]);

  // Freshest block we can get: the chain if it answers, else the node's view.
  const chainBlock = l1Client ? await safe(l1Client.getBlockNumber()) : null;
  out.currentBlock = chainBlock ?? out.asOfBlock;

  // ---- matches: phase + clocks from snapshots ----
  const clockByKey = new Map();
  for (const c of out.commitments) {
    if (!c.snapshot) continue;
    clockByKey.set(
      `${(c.tournamentAddress || "").toLowerCase()}:${(c.commitment || "").toLowerCase()}`,
      {
        running: c.snapshot.clockRunning ?? null,
        deadline: c.snapshot.clockDeadline ?? null,
        allowance: c.snapshot.clockAllowance ?? null,
        claimer: c.snapshot.claimer ?? null,
      },
    );
  }
  for (const m of out.matches) {
    const s = m.snapshot;
    m.phase = s?.phase ?? null;
    m.currentHeight = s?.bisection?.currentHeight ?? null;
    m.responder = s?.bisection?.responder ?? null;
    m.timeoutOutcome = s?.timeoutOutcome ?? null;
    const t = (m.tournamentAddress || "").toLowerCase();
    m.clocks = [m.commitmentOne, m.commitmentTwo].map(
      (c) => clockByKey.get(`${t}:${(c || "").toLowerCase()}`) ?? null,
    );
    m.blocksToTimeout = null;
    if (!isMatchActive(m)) continue;
    const onClock = m.responder === "TWO" ? m.clocks[1] : m.clocks[0];
    if (onClock?.running && onClock.deadline != null && out.currentBlock != null) {
      const left = BigInt(onClock.deadline) - BigInt(out.currentBlock);
      m.blocksToTimeout = left > 0n ? left : 0n;
    }
  }

  // ---- staging ----
  if (epochStatus(epoch).label === "STAGED") {
    const read = (functionName, args = []) =>
      l1Client && consensusAddress
        ? safe(
            l1Client.readContract({
              address: consensusAddress,
              abi: daveConsensusAbi,
              functionName,
              args,
            }),
          )
        : Promise.resolve(null);

    const [can, sentryCount] = await Promise.all([
      read("canAcceptStagedTournamentResult"),
      read("getNumberOfSentries"),
    ]);

    // Sentry claims: `agreeing` claimed the staged hash, `claimed` claimed
    // anything this epoch. claimed > agreeing means someone claimed a
    // different hash — that is a dissent.
    let sentries = null;
    if (can && can[0] && sentryCount != null && sentryCount > 0n) {
      const total = Number(sentryCount);
      const epochNumber = can[3];
      const [agreeing, ...claimedFlags] = await Promise.all([
        read("getSentryClaimCount", [epochNumber, can[4]]),
        ...Array.from({ length: total }, (_, i) =>
          read("hasSentryClaimedInEpoch", [epochNumber, BigInt(i + 1)]),
        ),
      ]);
      const claimed = claimedFlags.filter((f) => f === true).length;
      sentries = {
        total,
        agreeing: agreeing == null ? null : Number(agreeing),
        claimed,
        dissent: agreeing != null && claimed > Number(agreeing),
      };
    }

    let blocksLeft = null;
    if (
      epoch.stagedAtBlock != null &&
      claimStagingPeriod != null &&
      out.currentBlock != null
    ) {
      const left =
        BigInt(epoch.stagedAtBlock) +
        BigInt(claimStagingPeriod) -
        BigInt(out.currentBlock);
      blocksLeft = left > 0n ? left : 0n;
    }

    // Nothing usable came back — leave the row hidden.
    if (can != null || blocksLeft != null) {
      out.staging = {
        staged: can ? can[0] : true,
        // fast path: every sentry already claimed the staged hash
        sentriesAgree: can ? can[1] : null,
        isOver: can ? can[2] : blocksLeft === 0n,
        periodBlocks: claimStagingPeriod ?? null,
        blocksLeft,
        sentries,
      };
    }
  }

  return out;
}

// -------------------------------------------------------------
// view helpers
//
// Pure: view-model in, display primitives out. Kept here rather than in the
// renderer so the interesting cases can be asserted without a DOM.
// -------------------------------------------------------------

// Tournament clocks are denominated in blocks (Time.Instant is block.number).
// A raw block delta means little to a reader, so pair it with wall time.
export function formatBlocks(n, secondsPerBlock = 2) {
  if (n == null) return "—";
  const b = Number(n);
  if (!Number.isFinite(b)) return "—";
  if (b <= 0) return "now";
  const secs = b * secondsPerBlock;
  const t =
    secs < 60
      ? `~${secs}s`
      : secs < 3600
        ? `~${Math.round(secs / 60)}m`
        : `~${Math.round(secs / 3600)}h`;
  // non-breaking spaces: the quantity is one unit and should not be split
  // across a wrapped line ("35" / "blk (~1m)")
  return `${b} blk (${t})`;
}

/** One line describing the staged-claim countdown, or null when not staged. */
export function describeStaging(prt, secondsPerBlock = 2) {
  const s = prt?.staging;
  if (!s) return null;
  const n = s.sentries;
  // A sentry that claimed another hash is the one fact worth shouting; the
  // staging period must then run its course.
  if (n?.dissent) {
    const when = s.isOver
      ? "staging period over — awaiting acceptance"
      : `accepts in ${formatBlocks(s.blocksLeft, secondsPerBlock)}`;
    return {
      text: `a sentry disagrees (${n.agreeing}/${n.claimed} claimed the staged result) · ${when}`,
      tone: "bad",
    };
  }
  // Fast path: every sentry claimed the staged hash, no need to wait.
  if (s.sentriesAgree === true)
    return {
      text: `all ${n?.total ?? ""} sentries agree — acceptable now`.replace("  ", " "),
      tone: "ok",
    };
  if (s.isOver)
    return { text: "staging period over — awaiting acceptance", tone: "dim" };
  return {
    text: `accepts in ${formatBlocks(s.blocksLeft, secondsPerBlock)}`,
    tone: "dim",
  };
}

/** Summary line for the collapsed dispute row. */
export function describeDispute(prt) {
  if (!prt?.disputed) return null;
  const bits = [];
  if (prt.epochIndex != null) bits.push(`epoch #${prt.epochIndex}`);
  bits.push(
    `${prt.commitmentCount} commitments`,
    `${prt.activeMatchCount}/${prt.matchCount} matches active`,
  );
  if (prt.tournaments.length > 1)
    bits.push(`${prt.tournaments.length} tournaments`);
  return {
    standing: prt.root?.standing ?? { label: "DISPUTE", tone: "bad" },
    meta: bits.join(" · "),
  };
}

/**
 * Flatten the tournament tree into renderable rows, interleaving each
 * tournament with the matches that belong to it, then any caveats.
 */
export function describeTree(prt, secondsPerBlock = 2) {
  if (!prt) return [];
  const byTournament = new Map();
  for (const m of prt.matches ?? []) {
    const k = (m.tournamentAddress || "").toLowerCase();
    if (!byTournament.has(k)) byTournament.set(k, []);
    byTournament.get(k).push(m);
  }

  const out = [];
  for (const { node, depth } of prt.order ?? []) {
    out.push({
      kind: "tournament",
      depth,
      label: Number(node.level) === 0 ? "root" : `L${node.level}`,
      address: node.address,
      standing: node.standing ?? null,
    });
    for (const m of byTournament.get((node.address || "").toLowerCase()) ?? []) {
      const active = isMatchActive(m);
      const label = active
        ? [
            m.phase ?? "match",
            m.currentHeight != null ? `h=${m.currentHeight}` : null,
            // ASCII only: the panel renders in a mono stack that has no emoji
            // coverage on plenty of Linux setups, where a clock glyph is tofu.
            m.blocksToTimeout != null
              ? `${m.responder ?? "?"} on clock · ${formatBlocks(m.blocksToTimeout, secondsPerBlock)}`
              : null,
            TIMEOUT_OUTCOME[m.timeoutOutcome] ?? null,
          ]
            .filter(Boolean)
            .join(" · ")
        : (DELETION_REASON[m.deletionReason] ?? m.deletionReason);
      out.push({
        kind: "match",
        depth: depth + 1,
        idHash: m.idHash,
        label,
        active,
      });
    }
  }

  if (prt.snapshotOk === false)
    out.push({
      kind: "note",
      label: "live dispute state unavailable from this node",
    });
  if (
    prt.asOfBlock != null &&
    prt.currentBlock != null &&
    BigInt(prt.currentBlock) > BigInt(prt.asOfBlock)
  ) {
    const lag = BigInt(prt.currentBlock) - BigInt(prt.asOfBlock);
    out.push({
      kind: "note",
      label: `node view as of block ${prt.asOfBlock} · ${formatBlocks(lag, secondsPerBlock)} behind`,
    });
  }
  return out;
}
