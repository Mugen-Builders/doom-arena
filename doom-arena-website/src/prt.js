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

// -------------------------------------------------------------
// ABI — ITournament reads, Dave v3.0.0-alpha.5
// Verified against the same artifact set. Read directly when the node has not
// indexed the tournament (live Base Sepolia: last_tournament_check_block = 0).
// -------------------------------------------------------------
export const tournamentAbi = parseAbi([
  "function tournamentStanding() view returns ((uint8 standing, bool acceptsJoins, bool hasCandidate, bytes32 candidate, bytes32 finalState, bytes32 parentCommitment, uint64 finishedAt, uint64 winnerExpiresAt))",
  "function getCommitmentJoinedCount() view returns (uint256)",
  "function getMatchCreatedCount() view returns (uint256)",
  "function getMatchDeletedCount() view returns (uint256)",
  "function getNewInnerTournamentCount() view returns (uint256)",
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

// Solidity enum order of ITournament.TournamentStanding (alpha.5). The
// contract returns the index; the node returns the name. Pinned by test.
export const TOURNAMENT_STANDING_INDEX = [
  "MATCHES_ACTIVE",
  "AWAITING_CLOSURE",
  "ROOT_WINNER",
  "ROOT_FAILED",
  "INNER_WINNER",
  "INNER_ELIMINABLE_NO_WINNER",
  "INNER_ELIMINABLE_WINNER_EXPIRED",
];

export const standingFromIndex = (i) =>
  i == null ? null : standingOf(TOURNAMENT_STANDING_INDEX[Number(i)] ?? `#${i}`);

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

const sameAddress = (a, b) =>
  !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
const isZeroAddress = (a) => !a || /^0x0{40}$/i.test(String(a));

// Inputs an epoch spans, from its index bounds (node Epoch or contract view).
export const inputsOf = (e) =>
  e?.inputIndexUpperBound != null && e?.inputIndexLowerBound != null
    ? Number(BigInt(e.inputIndexUpperBound) - BigInt(e.inputIndexLowerBound))
    : null;

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
// consensus state — straight from the contracts
//
// The node's epoch status is what the node has *done*, not what the chain
// says. A node that computed a claim and never submitted it reports
// CLAIM_COMPUTED forever while the tournament on-chain times out and fails.
// The sealed epoch, its tournament and their standing are read here and win
// over the node's label; the node's label is kept as a secondary note.
// -------------------------------------------------------------

/**
 * Read the current sealed epoch and its root tournament. Never throws;
 * returns null when there is no chain client / consensus address or the
 * primary read fails. viem's batch transport collapses the calls.
 *
 * `nodeHasTournaments` skips the match/inner counters when the node already
 * serves tournament rows (they only feed the degrade path).
 */
export async function fetchConsensusState({
  l1Client,
  consensusAddress,
  nodeHasTournaments = true,
}) {
  if (!l1Client || !consensusAddress) return null;
  const read = (address, abi, functionName, args = []) =>
    safe(l1Client.readContract({ address, abi, functionName, args }));

  const [sealed, canStage, blockNumber] = await Promise.all([
    read(consensusAddress, daveConsensusAbi, "getCurrentSealedEpoch"),
    read(consensusAddress, daveConsensusAbi, "canStageTournamentResult"),
    safe(l1Client.getBlockNumber()),
  ]);
  if (!sealed) return null;

  const out = {
    consensusAddress,
    epochNumber: sealed[0],
    inputIndexLowerBound: sealed[1],
    inputIndexUpperBound: sealed[2],
    tournament: isZeroAddress(sealed[3]) ? null : sealed[3],
    staged: sealed[4] === true,
    stagingBlockNumber: sealed[5] ?? null,
    isFinished: canStage ? canStage[0] === true : null,
    isFailed: canStage ? canStage[1] === true : null,
    standing: null,
    acceptsJoins: null,
    finishedAt: null,
    joined: null,
    matchesCreated: null,
    matchesDeleted: null,
    innerTournaments: null,
    canAccept: null, // canAcceptStagedTournamentResult tuple, when staged
    currentBlock: blockNumber,
  };

  const t = out.tournament;
  const [standing, joined, canAccept, created, deleted, inner] = await Promise.all([
    t ? read(t, tournamentAbi, "tournamentStanding") : null,
    t ? read(t, tournamentAbi, "getCommitmentJoinedCount") : null,
    out.staged ? read(consensusAddress, daveConsensusAbi, "canAcceptStagedTournamentResult") : null,
    t && !nodeHasTournaments ? read(t, tournamentAbi, "getMatchCreatedCount") : null,
    t && !nodeHasTournaments ? read(t, tournamentAbi, "getMatchDeletedCount") : null,
    t && !nodeHasTournaments ? read(t, tournamentAbi, "getNewInnerTournamentCount") : null,
  ]);
  if (standing) {
    // viem returns named tuples as objects; tolerate positional too.
    const idx = standing.standing ?? standing[0];
    out.standing = standingFromIndex(idx);
    out.acceptsJoins = standing.acceptsJoins ?? standing[1] ?? null;
    out.finishedAt = standing.finishedAt ?? standing[6] ?? null;
  }
  out.joined = joined;
  out.canAccept = canAccept;
  out.matchesCreated = created;
  out.matchesDeleted = deleted;
  out.innerTournaments = inner;
  out.phase = consensusPhase(out);
  return out;
}

/**
 * What the sealed epoch is doing, in contract terms. Order matters: staging
 * and a finished tournament are decided by the consensus contract; the rest
 * by the tournament's standing and whether anyone has claimed at all.
 */
export function consensusPhase(c) {
  if (!c) return null;
  if (c.staged) {
    const over = c.canAccept ? c.canAccept[2] === true : false;
    return over
      ? { key: "AWAITING_ACCEPTANCE", label: "AWAITING ACCEPTANCE", tone: "pending", detail: "staging period over · anyone may accept the result" }
      : { key: "STAGED", label: "STAGED", tone: "pending", detail: null };
  }
  if (c.isFinished && c.isFailed)
    return { key: "FAILED", label: "TOURNAMENT FAILED", tone: "bad", detail: "no claim within allowance · epoch cannot settle" };
  if (c.isFinished)
    return { key: "AWAITING_STAGING", label: "SETTLED · AWAITING STAGING", tone: "pending", detail: "winner decided · anyone may stage the result" };
  const s = c.standing?.key;
  const joined = c.joined == null ? null : Number(c.joined);
  if (s === "MATCHES_ACTIVE")
    return { key: "DISPUTE", label: "DISPUTE ACTIVE", tone: "bad", detail: null };
  if (joined === 0)
    return { key: "AWAITING_CLAIM", label: "AWAITING CLAIM", tone: "pending", detail: "no claim submitted yet" };
  if (s === "AWAITING_CLOSURE" || joined != null)
    return {
      key: "IN_TOURNAMENT",
      label: "IN TOURNAMENT",
      tone: "pending",
      detail: joined == null ? "challenge window open" : `${joined} claim${joined === 1 ? "" : "s"} · challenge window open`,
    };
  return { key: "SEALED", label: "SEALED", tone: "pending", detail: null };
}

/** Phases worth polling fast for: a countdown or a fight. A plain challenge
 * window (IN_TOURNAMENT) lasts hours and is not worth hammering the RPC. */
export const isLivePhase = (phase) => ["DISPUTE", "STAGED"].includes(phase?.key);

/**
 * The newest accepted epoch. The node knows it from events it indexed; the
 * contract implies it: epoch N is sealed only once N-1 was accepted.
 */
export function deriveLastAccepted(nodeIndex, consensus) {
  const fromChain =
    consensus?.epochNumber != null && BigInt(consensus.epochNumber) > 0n
      ? BigInt(consensus.epochNumber) - 1n
      : null;
  if (nodeIndex == null) return fromChain;
  if (fromChain == null) return BigInt(nodeIndex);
  return BigInt(nodeIndex) > fromChain ? BigInt(nodeIndex) : fromChain;
}

// -------------------------------------------------------------
// main fetch
// -------------------------------------------------------------

/**
 * Collect PRT status for one epoch: three node list calls, one eth_call for a
 * staged claim, and one eth_blockNumber when an L1 client is available.
 * With `consensus` (fetchConsensusState) the chain block, staging tuple and
 * root standing come from there, and a tournament the node never indexed is
 * still shown from its on-chain counters.
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
  consensus = null,
}) {
  const out = {
    epochIndex: epoch?.index ?? consensus?.epochNumber ?? null,
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
    chainCounts: null, // counters read from the tournament when the node has no rows
  };
  const epochIndex = out.epochIndex;
  if (epochIndex == null || !nodeClient) return out;

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
    (epoch?.tournamentAddress
      ? { address: epoch.tournamentAddress, level: 0n, children: [], standing: null }
      : null);

  // The node may not have indexed the tournament at all; the contract still
  // knows the root and its standing.
  const chainRoot = consensus?.tournament ?? null;
  if (!out.root && chainRoot) {
    out.root = { address: chainRoot, level: 0n, children: [], standing: consensus.standing ?? null, fromChain: true };
  }
  if (out.root && !out.root.standing && consensus?.standing && sameAddress(out.root.address, chainRoot)) {
    out.root.standing = consensus.standing;
  }
  if (out.root && !out.order.length) out.order = [{ node: out.root, depth: 0 }];
  if (consensus && !out.tournaments.length && consensus.joined != null) {
    const n = (v) => (v == null ? 0 : Number(v));
    out.chainCounts = {
      joined: n(consensus.joined),
      matchesCreated: n(consensus.matchesCreated),
      matchesDeleted: n(consensus.matchesDeleted),
      innerTournaments: n(consensus.innerTournaments),
    };
    if (out.chainCounts.joined > 1 || out.chainCounts.matchesCreated > 0) out.disputed = true;
  }

  if (out.tournaments.length)
    out.snapshotOk = out.tournaments.every((t) => t.snapshot != null);

  out.asOfBlock = maxBig([
    ...out.tournaments.map((t) => t.snapshot?.asOfBlock),
    ...out.matches.map((m) => m.snapshot?.asOfBlock),
    ...out.commitments.map((c) => c.snapshot?.asOfBlock),
  ]);

  // Freshest block we can get: the chain if it answers, else the node's view.
  const chainBlock =
    consensus?.currentBlock ?? (l1Client ? await safe(l1Client.getBlockNumber()) : null);
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
  // The contract decides whether the claim is staged; the node's label is the
  // fallback when no chain state was read.
  const isStaged = consensus ? consensus.staged : epochStatus(epoch).label === "STAGED";
  if (isStaged) {
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
      consensus?.canAccept ?? read("canAcceptStagedTournamentResult"),
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
    const stagedAt = epoch?.stagedAtBlock ?? consensus?.stagingBlockNumber ?? null;
    if (
      stagedAt != null &&
      claimStagingPeriod != null &&
      out.currentBlock != null
    ) {
      const left =
        BigInt(stagedAt) +
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

/** Summary line for the collapsed dispute row (the row head names the epoch). */
export function describeDispute(prt) {
  if (!prt?.disputed) return null;
  const bits = [];
  const c = prt.chainCounts;
  if (c) {
    bits.push(
      `${c.joined} commitments`,
      `${c.matchesCreated - c.matchesDeleted}/${c.matchesCreated} matches active`,
    );
    if (c.innerTournaments > 0) bits.push(`${c.innerTournaments} inner tournaments`);
    bits.push("from chain");
  } else {
    bits.push(
      `${prt.commitmentCount} commitments`,
      `${prt.activeMatchCount}/${prt.matchCount} matches active`,
    );
    if (prt.tournaments.length > 1)
      bits.push(`${prt.tournaments.length} tournaments`);
  }
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

  if (prt.chainCounts) {
    const c = prt.chainCounts;
    out.push({
      kind: "note",
      label: `node has not indexed this tournament · chain: ${c.joined} commitments · ${c.matchesCreated} matches (${c.matchesDeleted} ended) · ${c.innerTournaments} inner`,
    });
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

/**
 * The settling epoch row: contract phase first, node status as a note when it
 * disagrees. Without chain state this is just the node's status.
 * Returns null when there is nothing to show.
 */
export function describeSettling({ epoch = null, consensus = null, prt = null } = {}) {
  const phase = consensusPhase(consensus);
  const nodeSt = epoch ? epochStatus(epoch) : null;
  if (!phase) {
    if (!epoch) return null;
    return {
      source: "node",
      key: null,
      label: nodeSt.label,
      tone: nodeSt.tone,
      epochIndex: epoch.index ?? null,
      inputs: inputsOf(epoch),
      detail: null,
      nodeNote: null,
    };
  }
  let detail = phase.detail;
  // The dispute line under the row carries the counts; do not say them twice.
  if (phase.key === "DISPUTE" && prt?.disputed) detail = null;
  let nodeNote = null;
  if (!epoch) nodeNote = `node has no epoch #${consensus.epochNumber} yet`;
  else if (epoch.index != null && BigInt(epoch.index) !== BigInt(consensus.epochNumber))
    nodeNote = `node is on epoch #${epoch.index} · ${nodeSt.label}`;
  else if (nodeSt.label !== phase.label) nodeNote = `node: ${nodeSt.label}`;
  return {
    source: "chain",
    key: phase.key,
    label: phase.label,
    tone: phase.tone,
    epochIndex: consensus.epochNumber,
    inputs: inputsOf(consensus) ?? inputsOf(epoch),
    detail,
    nodeNote,
  };
}
