// =============================================================
// PRT / Dave consensus — status reads
// =============================================================
// The rollups node indexes the *structure* of a dispute (which tournaments
// exist, who joined, which matches were created and how they ended). It does
// not index *live* state: tournament standing, commitment clocks, match phase,
// or whether a result can be staged/accepted. Those are read straight from the
// contracts.
//
//   node RPC  -> epochs, tournament tree, commitments, matches   (history)
//   eth_call  -> standing, clocks, phase, canStage/canAccept     (live)
//
// CONTRACT GENERATIONS
// Dave replaced its entire read surface between 3.0.0-alpha.3 and
// 3.0.0-alpha.4 — the two share no observer functions at all. Node
// v2.0.0-alpha.12 pins contracts 3.0.0-alpha.3 (see its Makefile,
// ROLLUPS_PRT_CONTRACTS_VERSION); the release that carries the new emulator is
// expected to move to 3.0.0-alpha.4. We target alpha.4 and keep a reduced
// alpha.3 fallback so a deployment against either generation still shows
// something. Generation is probed once and cached.
//
// Value types, per the alpha.4 artifacts:
//   Machine.Hash, Tree.Node          -> bytes32
//   Time.Instant, Time.Duration      -> uint64   (block numbers / block counts)
//   every enum                       -> uint8
// =============================================================

import { parseAbi } from "viem";

// -------------------------------------------------------------
// ABIs — Dave v3.0.0-alpha.4
// Verified against cartesi-rollups-prt-3.0.0-alpha.4-contract-artifacts.
// -------------------------------------------------------------
export const daveConsensusAbiV4 = parseAbi([
  "function getCurrentSealedEpoch() view returns (uint256 epochNumber, uint256 inputIndexLowerBound, uint256 inputIndexUpperBound, address tournament, bool isTournamentResultStaged, uint256 stagingBlockNumber, bytes32 stagedPostEpochMachineStateHash, bytes32 stagedPostEpochOutputsMerkleRoot)",
  "function canStageTournamentResult() view returns (bool isFinished, bool isTournamentFailed, bool isTournamentResultStaged, uint256 epochNumber, bytes32 winnerCommitment, bytes32 winnerPostEpochMachineStateHash)",
  "function canAcceptStagedTournamentResult() view returns (bool isTournamentResultStaged, bool doAllSentriesAgreeWithStagedTournamentResult, bool isClaimStagingPeriodOver, uint256 epochNumber, bytes32 stagedPostEpochMachineStateHash, bytes32 stagedPostEpochOutputsMerkleRoot)",
  "function getClaimStagingPeriod() view returns (uint256)",
]);

export const tournamentAbiV4 = parseAbi([
  "struct TournamentStandingView { uint8 standing; bool acceptsJoins; bool hasCandidate; bytes32 candidate; bytes32 finalState; bytes32 parentCommitment; uint64 finishedAt; uint64 winnerExpiresAt; }",
  "struct CommitmentStandingView { bool joined; bytes32 finalState; address claimer; bool clockRunning; uint64 clockDeadline; uint64 clockAllowance; }",
  "struct BisectingMatchView { bytes32 revealingParent; bytes32 waitingLeft; bytes32 waitingRight; uint256 segmentStartPosition; uint256 segmentStartCycle; uint64 currentHeight; uint8 responder; }",
  "function tournamentStanding() view returns (TournamentStandingView)",
  "function commitmentStanding(bytes32 commitmentRoot) view returns (CommitmentStandingView)",
  "function bisectingMatch(bytes32 matchIdHash) view returns (uint8 actualPhase, BisectingMatchView value)",
]);

// -------------------------------------------------------------
// ABIs — Dave v3.0.0-alpha.3 (reduced fallback)
// Only the tournament reads needed to keep the panel meaningful; the alpha.3
// consensus surface is not read at all.
// -------------------------------------------------------------
export const tournamentAbiV3 = parseAbi([
  "function isFinished() view returns (bool)",
  "function isClosed() view returns (bool)",
  "function arbitrationResult() view returns (bool finished, bytes32 winnerCommitment, bytes32 finalState)",
  "function tournamentLevelConstants() view returns (uint64 maxLevel, uint64 level, uint64 log2step, uint64 height)",
]);

// -------------------------------------------------------------
// Enum / status maps
//
// `tone` must name a real .status-<tone> rule in arena.css.
// -------------------------------------------------------------
// Node EpochStatus (jsonrpc-discover.json @ node v2.0.0-alpha.12).
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

// An unknown status must stay legible rather than render as raw unstyled text,
// which is what the previous substring-matching implementation did for CLOSED
// and INPUTS_PROCESSED.
export function epochStatus(epoch) {
  const raw = (epoch?.status ?? epoch?.state ?? "").toString();
  return (
    EPOCH_STATUS[raw.toUpperCase()] ?? {
      label: raw ? raw.replace(/_/g, " ").toUpperCase() : "—",
      tone: "pending",
    }
  );
}

// ITournament.TournamentStanding — index order is the on-chain enum order.
export const TOURNAMENT_STANDING = [
  { key: "MATCHES_ACTIVE", label: "DISPUTE ACTIVE", tone: "bad" },
  { key: "AWAITING_CLOSURE", label: "AWAITING CLOSURE", tone: "pending" },
  { key: "ROOT_WINNER", label: "SETTLED", tone: "ok" },
  { key: "ROOT_FAILED", label: "FAILED — NO WINNER", tone: "bad" },
  { key: "INNER_WINNER", label: "INNER WINNER", tone: "ok" },
  { key: "INNER_ELIMINABLE_NO_WINNER", label: "ELIMINABLE", tone: "bad" },
  { key: "INNER_ELIMINABLE_WINNER_EXPIRED", label: "ELIMINABLE", tone: "bad" },
];

export const MATCH_PHASE = [
  "UNINITIALIZED",
  "BISECTING",
  "READY_TO_SEAL",
  "SEALED",
];

export const COMMITMENT_SIDE = ["ONE", "TWO"];

// Node MatchDeletionReason. NOT_DELETED is the node's own marker for a match
// that is still live; it is not an on-chain enum member.
export const DELETION_REASON = {
  NOT_DELETED: "active",
  STEP: "proven wrong by step",
  TIMEOUT: "timed out",
  CHILD_TOURNAMENT: "decided by inner tournament",
};

export const standingOf = (i) =>
  TOURNAMENT_STANDING[Number(i)] ?? {
    key: `UNKNOWN_${i}`,
    label: "UNKNOWN",
    tone: "pending",
  };

export const isMatchActive = (m) =>
  !m?.deletionReason || m.deletionReason === "NOT_DELETED";

// -------------------------------------------------------------
// helpers
// -------------------------------------------------------------

// Mirrors the safe() idiom already used in main.js: a failed read yields null
// for that one field instead of taking down the whole panel. This is what makes
// an ABI-generation mismatch degrade to node-only data.
const safe = (p) => Promise.resolve(p).then((v) => v, () => null);

const totalCount = (r) =>
  Number(r?.pagination?.total_count ?? r?.pagination?.totalCount ?? 0);

const rows = (r) => (Array.isArray(r) ? r : (r?.data ?? []));

// Generation is a property of the deployment, so resolve once and remember.
//
// It is resolved against a *tournament*, not the consensus contract: the
// obvious-looking probe (does IDaveConsensus have getClaimStagingPeriod?) gives
// a false positive, because the plain IConsensus that authority deployments use
// also answers it. ITournament's two generations, by contrast, share no read
// functions at all, so tournamentStanding() is an unambiguous discriminator.
const GENERATION_CACHE = new Map();

/**
 * Read a tournament's standing, trying alpha.4 first and alpha.3 second.
 * Returns null when neither generation answers (no chain, wrong address, or a
 * third generation we do not know about).
 */
export async function readTournamentStanding(l1Client, address) {
  if (!l1Client || !address) return null;

  const v4 = await safe(
    l1Client.readContract({
      address,
      abi: tournamentAbiV4,
      functionName: "tournamentStanding",
    }),
  );
  if (v4) {
    return {
      generation: "v4",
      standing: standingOf(v4.standing),
      acceptsJoins: v4.acceptsJoins,
      hasCandidate: v4.hasCandidate,
      candidate: v4.candidate,
      finishedAt: v4.finishedAt,
      winnerExpiresAt: v4.winnerExpiresAt,
    };
  }

  // alpha.3 has no standing enum; synthesise one from isFinished +
  // arbitrationResult. A finished tournament with a zero winner commitment is
  // the alpha.3 spelling of ROOT_FAILED.
  const [finished, closed, arb] = await Promise.all([
    safe(
      l1Client.readContract({
        address,
        abi: tournamentAbiV3,
        functionName: "isFinished",
      }),
    ),
    safe(
      l1Client.readContract({
        address,
        abi: tournamentAbiV3,
        functionName: "isClosed",
      }),
    ),
    safe(
      l1Client.readContract({
        address,
        abi: tournamentAbiV3,
        functionName: "arbitrationResult",
      }),
    ),
  ]);
  if (finished == null) return null;

  const hasWinner =
    Array.isArray(arb) && arb[0] === true && !/^0x0*$/.test(arb[1] ?? "0x0");
  return {
    generation: "v3",
    standing: finished ? (hasWinner ? standingOf(2) : standingOf(3)) : standingOf(0),
    acceptsJoins: closed === false,
    hasCandidate: hasWinner,
    candidate: Array.isArray(arb) ? arb[1] : null,
    finishedAt: null,
    winnerExpiresAt: null,
  };
}

export async function detectGeneration(l1Client, tournamentAddress) {
  if (!l1Client || !tournamentAddress) return null;
  const key = tournamentAddress.toLowerCase();
  if (GENERATION_CACHE.has(key)) return GENERATION_CACHE.get(key);
  const res = await readTournamentStanding(l1Client, tournamentAddress);
  const gen = res?.generation ?? null;
  if (gen) GENERATION_CACHE.set(key, gen);
  return gen;
}

export function _resetGenerationCache() {
  GENERATION_CACHE.clear();
}

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
 * Collect PRT status for one epoch.
 *
 * Collapsed: ~4 node calls + ~3 eth_calls.
 * Expanded adds one standing read per tournament and, per active match, a phase
 * read plus two clock reads — all batched into few HTTP round trips.
 *
 * Never throws: every read is individually guarded.
 */
export async function fetchPrtState({
  cartesiClient,
  l1Client,
  application,
  consensusAddress,
  epoch,
  claimStagingPeriod,
  expanded = false,
}) {
  const out = {
    generation: null,
    consensusAddress: consensusAddress ?? null,
    tournaments: [],
    order: [],
    root: null,
    matches: [],
    commitmentCount: 0,
    matchCount: 0,
    activeMatchCount: 0,
    disputed: false,
    staging: null,
    currentBlock: null,
    chainOk: false,
  };
  if (!epoch) return out;

  const epochIndex = epoch.index;

  // Commitments are counted, not listed — pagination.total_count is enough and
  // costs no row transfer. Tournaments and matches are capped at 50: the counts
  // stay exact (they come from total_count too), only the rendered detail
  // truncates, which no realistic dispute on a test app will reach.
  const [tournamentsR, commitmentsR, matchesR] = await Promise.all([
    safe(cartesiClient.listTournaments({ application, epochIndex, limit: 50 })),
    safe(cartesiClient.listCommitments({ application, epochIndex, limit: 1 })),
    safe(cartesiClient.listMatches({ application, epochIndex, limit: 50 })),
  ]);

  out.tournaments = rows(tournamentsR);
  out.commitmentCount = totalCount(commitmentsR);
  out.matches = rows(matchesR);
  out.matchCount = totalCount(matchesR) || out.matches.length;
  out.activeMatchCount = out.matches.filter(isMatchActive).length;

  // More than one commitment means validators disagreed on the post-epoch
  // state; a match is the tournament pairing them off. Either is a dispute.
  out.disputed = out.commitmentCount > 1 || out.matchCount > 0;

  const { roots, order } = buildTournamentTree(out.tournaments);
  out.order = order;
  out.root =
    roots.find((r) => Number(r.level) === 0) ??
    roots[0] ??
    (epoch.tournamentAddress
      ? { address: epoch.tournamentAddress, level: 0n, children: [] }
      : null);

  if (!l1Client) return out;

  const blockNumber = await safe(l1Client.getBlockNumber());
  out.currentBlock = blockNumber;

  // Root standing — the single most informative live fact. This also settles
  // which contract generation we are talking to.
  if (out.root?.address) {
    const res = await readTournamentStanding(l1Client, out.root.address);
    if (res) {
      out.chainOk = true;
      out.generation = res.generation;
      GENERATION_CACHE.set(out.root.address.toLowerCase(), res.generation);
      out.root.standing = res.standing;
      out.root.acceptsJoins = res.acceptsJoins;
      out.root.hasCandidate = res.hasCandidate;
      out.root.candidate = res.candidate;
      out.root.finishedAt = res.finishedAt;
    }
  }

  // Staging is an alpha.4 concept; alpha.3 settles in a single step. Only
  // report it when the chain actually answered, so a revert leaves the row
  // hidden rather than showing an empty countdown.
  if (
    out.generation === "v4" &&
    consensusAddress &&
    epochStatus(epoch).label === "STAGED"
  ) {
    const can = await safe(
      l1Client.readContract({
        address: consensusAddress,
        abi: daveConsensusAbiV4,
        functionName: "canAcceptStagedTournamentResult",
      }),
    );
    const period =
      claimStagingPeriod ??
      (await safe(
        l1Client.readContract({
          address: consensusAddress,
          abi: daveConsensusAbiV4,
          functionName: "getClaimStagingPeriod",
        }),
      ));

    // stagedAtBlock comes from the node, but older @cartesi/viem builds drop
    // the field. getCurrentSealedEpoch() carries the same block on-chain, so
    // fall back to it rather than losing the countdown.
    let stagedAt = epoch.stagedAtBlock;
    if (stagedAt == null) {
      const sealed = await safe(
        l1Client.readContract({
          address: consensusAddress,
          abi: daveConsensusAbiV4,
          functionName: "getCurrentSealedEpoch",
        }),
      );
      if (sealed && sealed[4]) stagedAt = sealed[5]; // isTournamentResultStaged -> stagingBlockNumber
    }

    let blocksLeft = null;
    if (stagedAt != null && period != null && blockNumber != null) {
      const left = BigInt(stagedAt) + BigInt(period) - BigInt(blockNumber);
      blocksLeft = left > 0n ? left : 0n;
    }

    // Nothing usable came back — leave the row hidden.
    if (can != null || blocksLeft != null) {
      out.staging = {
        staged: can ? can[0] : true,
        sentriesAgree: can ? can[1] : null,
        isOver: can ? can[2] : blocksLeft === 0n,
        periodBlocks: period ?? null,
        blocksLeft,
      };
    }
  }

  if (!expanded) return out;

  // ---- expanded detail ----
  // The alpha.3 surface has no per-match phase or clock projection, so the
  // expanded view is alpha.4 only; alpha.3 still shows the tree and the
  // node-indexed match outcomes.
  if (out.generation === "v4") {
    await Promise.all(
      out.order.map(async ({ node }) => {
        if (node === out.root || !node.address) return;
        const s = await safe(
          l1Client.readContract({
            address: node.address,
            abi: tournamentAbiV4,
            functionName: "tournamentStanding",
          }),
        );
        if (s) {
          node.standing = standingOf(s.standing);
          node.acceptsJoins = s.acceptsJoins;
        }
      }),
    );

    await Promise.all(
      out.matches.filter(isMatchActive).map(async (m) => {
        // bisectingMatch returns the match's *actual* phase whatever the
        // variant, so one call gives phase and bisection payload together.
        const res = await safe(
          l1Client.readContract({
            address: m.tournamentAddress,
            abi: tournamentAbiV4,
            functionName: "bisectingMatch",
            args: [m.idHash],
          }),
        );
        if (res) {
          m.phase = MATCH_PHASE[Number(res[0])] ?? "UNKNOWN";
          m.currentHeight = res[1]?.currentHeight ?? null;
          m.responder = COMMITMENT_SIDE[Number(res[1]?.responder ?? 0)];
        }
        const [c1, c2] = await Promise.all([
          safe(
            l1Client.readContract({
              address: m.tournamentAddress,
              abi: tournamentAbiV4,
              functionName: "commitmentStanding",
              args: [m.commitmentOne],
            }),
          ),
          safe(
            l1Client.readContract({
              address: m.tournamentAddress,
              abi: tournamentAbiV4,
              functionName: "commitmentStanding",
              args: [m.commitmentTwo],
            }),
          ),
        ]);
        m.clocks = [c1, c2].map((c) =>
          c
            ? {
                running: c.clockRunning,
                deadline: c.clockDeadline,
                allowance: c.clockAllowance,
                claimer: c.claimer,
              }
            : null,
        );
        // Blocks until the side on the clock times out.
        const onClock = m.responder === "TWO" ? m.clocks[1] : m.clocks[0];
        if (onClock?.running && blockNumber != null && onClock.deadline != null) {
          const left = BigInt(onClock.deadline) - BigInt(blockNumber);
          m.blocksToTimeout = left > 0n ? left : 0n;
        }
      }),
    );
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
  return `${b}\u00a0blk\u00a0(${t})`;
}

/** One line describing the staged-claim countdown, or null when not staged. */
export function describeStaging(prt, secondsPerBlock = 2) {
  const s = prt?.staging;
  if (!s) return null;
  // A dissenting sentry blocks acceptance outright — that outranks the clock.
  if (s.sentriesAgree === false)
    return { text: "a sentry disagrees with the result", tone: "bad" };
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
  const bits = [
    `${prt.commitmentCount} commitments`,
    `${prt.activeMatchCount}/${prt.matchCount} matches active`,
  ];
  if (prt.tournaments.length > 1)
    bits.push(`${prt.tournaments.length} tournaments`);
  return {
    standing: prt.root?.standing ?? { label: "DISPUTE", tone: "bad" },
    meta: bits.join(" · "),
  };
}

/**
 * Flatten the tournament tree into renderable rows, interleaving each
 * tournament with the matches that belong to it.
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
  return out;
}
