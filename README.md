# Polygon PoS Checkpoint + Validator Indexer (Envio HyperIndex)

Indexes Polygon PoS **checkpoints** and **validator lifecycle** from **Ethereum
mainnet (chainId 1)**, and — the whole point — recovers **which validators signed
each checkpoint** by `ecrecover`-ing the aggregated signature blob in the L1
`submitCheckpoint` calldata. That per-validator checkpoint-signing data exists
nowhere else (Heimdall REST only exposes the `jailed` flag and network-wide
counters; a subgraph can't `ecrecover`, but an Envio TypeScript handler can).

Everything is indexed **generically** (all validators / all checkpoints). Our
validator — Heimdall `val_id` **144**, L1 signer
**`0xea105ab4e3f01f7f8da09cb84ab501aeb02e9fc7`** — is only ever a **query-time
filter**, never hardcoded into the indexer.

---

## Contracts (all on Ethereum mainnet, verified against deployed source)

| Role | Address | Notes |
|------|---------|-------|
| RootChain (checkpoints) proxy | `0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287` | emits `NewHeaderBlock`; receives `submitCheckpoint` |
| RootChain implementation | `0x536c55cFe4892E581806e10b38dFE8083551bd03` | verified; `maticnetwork/contracts` @ commit `eef53596` |
| **StakingInfo** (event logger) | `0xa59C847Bd5aC0172Ff4FE912C5d29E5A71A7512B` | **emits all staking events** |
| StakeManager proxy | `0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908` | *not indexed directly* — see below |

> **Correction to the original spec:** the `Jailed`/`Staked`/`StakeUpdate`/… events
> are **not** emitted by the StakeManager. StakeManager calls a lightweight logger
> contract (`StakingInfo`) via `logger.logJailed(...)`, so the event `topic0`
> resolves to the **StakingInfo** address `0xa59C847B…7512B`. The indexer therefore
> points its staking-event contract at StakingInfo, not StakeManager. (Verified on
> the Etherscan-verified `StakingInfo` source, Solidity v0.5.17.)

Verified event/function signatures (all confirmed against the deployed impls):

```
RootChain:
  NewHeaderBlock(address indexed proposer, uint256 indexed headerBlockId,
                 uint256 indexed reward, uint256 start, uint256 end, bytes32 root)
  submitCheckpoint(bytes data, uint256[3][] sigs)              selector 0x4e43e495
  checkpointNumber = headerBlockId / 10000   (MAX_DEPOSITS = 10000)

StakingInfo:
  Staked(address indexed signer, uint256 indexed validatorId, uint256 nonce,
         uint256 indexed activationEpoch, uint256 amount, uint256 total, bytes signerPubkey)
  Unstaked(address indexed user, uint256 indexed validatorId, uint256 amount, uint256 total)
  StakeUpdate(uint256 indexed validatorId, uint256 indexed nonce, uint256 indexed newAmount)
  SignerChange(uint256 indexed validatorId, uint256 nonce, address indexed oldSigner,
               address indexed newSigner, bytes signerPubkey)
  Jailed(uint256 indexed validatorId, uint256 indexed exitEpoch, address indexed signer)
  UnJailed(uint256 indexed validatorId, address indexed signer)
  Slashed(uint256 indexed nonce, uint256 indexed amount)
```

---

## The vote-hash scheme (Tier 2) — derived from verified source

Validators do **not** sign the `NewHeaderBlock` event. They sign a **vote** over
the checkpoint `data`, and `StakeManager.checkSignatures` recovers signers from
that vote hash. From the deployed `RootChain.submitCheckpoint`
([`RootChain.sol` @ eef53596](https://github.com/maticnetwork/contracts/blob/eef53596046eda70a53653a8e5ff79b1cbf0a4f9/contracts/root/RootChain.sol)):

```solidity
(address proposer, uint256 start, uint256 end, bytes32 rootHash,
 bytes32 accountHash, uint256 _borChainID) =
    abi.decode(data, (address, uint256, uint256, bytes32, bytes32, uint256));
require(CHAINID == _borChainID, "Invalid bor chain id");
...
uint256 _reward = stakeManager.checkSignatures(
    end.sub(start).add(1),
    // prefix 01 to data — 01 = positive vote, 00 = negative vote
    keccak256(abi.encodePacked(bytes(hex"01"), data)),
    accountHash,
    proposer,
    sigs
);
```

So:

```
voteHash = keccak256( 0x01 ‖ data )      // data = the raw bytes arg to submitCheckpoint
```

Each signature is `uint256[3] = [r, s, v]`, unpacked by
[`ECVerify.ecrecovery`](https://github.com/maticnetwork/contracts/blob/eef53596046eda70a53653a8e5ff79b1cbf0a4f9/contracts/common/lib/ECVerify.sol)
which normalizes `v` (`if (v < 27) v += 27`) and requires `v ∈ {27,28}`.
`StakeManager.checkSignatures` requires the recovered signers to be **strictly
ascending** (dedups + rejects out-of-order), and sums their stake, requiring
`> 2/3` of total stake for the checkpoint to be accepted.

The handler replicates this exactly ([`src/EventHandlers.ts`](src/EventHandlers.ts),
`recoverSigners`): decode `submitCheckpoint` calldata → `voteHash = keccak256(0x01‖data)`
→ `recoverAddress` each `[r,s,v]` via viem.

### Tier-2 self-check — checkpoint 105648 ✅

Run against the real L1 transaction
`0x358f1b6ea6ff63b090758b8a07c4a2b7c4f941eeb1e989612ef4aea30de69540`
(L1 block 25,439,723). Decoded `data` matches Heimdall's reference values exactly
(proposer `0x203847fb…`, start `89484454`, end `89485221`, borChainId `137`):

```
voteHash                = 0xa48ab2a9b63562ae2870d014dd792a826456d5d7051fb6d516759744d0e261c3
signatures in blob      = 102
recovered signers       = 102
(a) includes proposer 0x203847fb…           = true   ✅
(b) strictly ascending & all unique (102)   = true   ✅
(c) > 2/3 of total stake                     = implied ✅ (tx was accepted on-chain,
        which checkSignatures only permits above 2/3; a stake-weighted recompute is
        available at query time from Validator.currentStake for in-window validators)
(d) OUR signer 0xea105ab4… present           = true   ✅
```

All gate conditions hold → the vote-hash derivation is correct.

---

## Entities (`schema.graphql`)

| Entity | Key | What it's for |
|--------|-----|---------------|
| `Checkpoint` | `checkpointNumber` | one row per checkpoint: proposer, start/end Bor blocks, root, reward, L1 block/timestamp/tx, `signerCount` |
| `CheckpointStats` | `"global"` | singleton: `latestCheckpointNumber`, `latestTimestamp`, `totalCheckpoints` → **latest-checkpoint-age** alert |
| `Validator` | `validatorId` | staking state: `signer`, `jailed`, jail/unjail timestamps, `currentStake`, `active`, plus mirrored signing counters |
| `Signer` | L1 address (lowercase) | **authoritative checkpoint-signing record**: `checkpointsSigned`, `checkpointsMissed`, `lastCheckpointSignedNumber/Timestamp`, resolved `validatorId` |
| `CheckpointSignature` | `${checkpointNumber}-${signer}` | one row per (checkpoint, signer) with resolved `validatorId` |
| `Slash` | slash nonce | network-wide slash events (see limitation) |
| `ActiveSignerSet` | `"global"` | internal working set for missed-count accounting |

### Why signing lives on `Signer` (keyed by address), not only `Validator`

`ecrecover` always yields the signer **address**; the `validatorId` is only known
if we observed the validator's `Staked`/`SignerChange` event **inside the indexed
window**. Validators that staked before `start_block` (including ours, val 144)
therefore have no `Validator` row — but their signing is fully tracked on `Signer`,
which the alert bridge queries by our signer address (a query-time filter, exactly
as intended). When the `signer → validatorId` mapping *is* known in-window, the
counters are also mirrored onto `Validator`.

---

## start_block rationale

`start_block: 25290000`. Checkpoint 105648 lands at L1 block **25,439,723**; head at
build time was ~25,439,970. `25,439,723 − 25,290,000 ≈ 149,700` blocks ≈ **~21 days**
≈ **~1000 checkpoints** (checkpoints land ~every 30 min, so Tier-2 backfill is light).
Pick an earlier block for more history; the cost is roughly linear in checkpoints
(each checkpoint = decode calldata + ~100 `ecrecover`s).

---

## GraphQL queries for the alert bridge

Filter by our validator at query time. Envio exposes a Hasura-style API.

**1. Latest checkpoint age (stall detection)** — alert if `now − latestTimestamp` is large:
```graphql
query LatestCheckpoint {
  CheckpointStats(where: { id: { _eq: "global" } }) {
    latestCheckpointNumber
    latestTimestamp
    totalCheckpoints
  }
}
```

**2. Is OUR validator jailed?** — `jailed: true` (or a fresh `lastJailedTimestamp`) fires the alert.
A `null` result means no jail/stake event for val 144 in-window → treat as *not jailed*:
```graphql
query OurValidatorJailed {
  Validator(where: { id: { _eq: "144" } }) {
    jailed
    lastJailedTimestamp
    lastUnjailedTimestamp
    currentStake
  }
}
```

**3. Is OUR validator signing checkpoints?** — the robust signal, keyed by signer address:
```graphql
query OurValidatorSigning {
  Signer(where: { id: { _eq: "0xea105ab4e3f01f7f8da09cb84ab501aeb02e9fc7" } }) {
    validatorId
    checkpointsSigned
    checkpointsMissed
    lastCheckpointSignedNumber
    lastCheckpointSignedTimestamp
  }
}
```

**Stall alert = exact & simplest:** compare `Signer.lastCheckpointSignedNumber`
(query 3) with `CheckpointStats.latestCheckpointNumber` (query 1). If the gap
exceeds a threshold, our validator has stopped signing — the early warning that
precedes jailing.

**4. Recent checkpoints our signer missed** (audit view):
```graphql
query RecentMisses {
  CheckpointSignature(
    where: { signer: { _eq: "0xea105ab4e3f01f7f8da09cb84ab501aeb02e9fc7" } }
    order_by: { checkpointNumber: desc }
    limit: 20
  ) { checkpointNumber l1Timestamp }
}
```

---

## Running locally

Requirements: Node ≥ 20, pnpm, and **Docker** (Envio's `dev` runs Postgres + Hasura).

```bash
pnpm install         # approves esbuild's build script via pnpm-workspace.yaml
pnpm codegen         # generates .envio/ types (no Docker needed)
pnpm dev             # starts Postgres + Hasura + the indexer (needs Docker)
```

GraphQL playground: http://localhost:8080 (Hasura). No RPC needed — HyperSync
serves logs **and** the transaction calldata (`field_selection.transaction_fields: [input]`).

**Validated in this environment** (no Docker available here):
`pnpm install` ✅, `pnpm codegen` ✅, `tsc --noEmit` ✅ (handlers type-check against
generated types), and the Tier-2 self-check against checkpoint 105648 ✅ (above).
`pnpm dev` was not run here because Docker is unavailable; it is the only step that
requires it.

---

## Known limitations (by design of L1-only data)

- **Per-validator slash attribution is not possible from L1.** `StakingInfo.Slashed(nonce, amount)`
  is a network-wide aggregate with **no validatorId**, so `Validator.totalSlashes`
  is not incremented from it (kept for schema completeness, stays `0`). Slash
  events are recorded network-wide in the `Slash` entity. The actionable
  per-validator signal is `jailed` + a drop in `currentStake` (from `StakeUpdate`).
- **`checkpointsMissed` is a heuristic.** L1 events don't expose Heimdall's exact
  per-checkpoint eligible set, so "missed" = a signer active within the last
  `ACTIVE_WINDOW` (40) checkpoints that was absent from a checkpoint's recovered
  signer set. For a precise, exact alert use the `lastCheckpointSignedNumber`
  gap (queries 1 + 3) instead of the running counter.
- **Pre-window validators have no `Validator` row** until they emit a staking
  event in-window; their signing is still tracked on `Signer`. Lower `start_block`
  to capture more of the validator set (at linear Tier-2 cost).
