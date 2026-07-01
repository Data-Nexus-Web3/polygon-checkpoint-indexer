/**
 * Polygon PoS checkpoint + validator indexer — event handlers.
 *
 * Tier 1 (plain events): Checkpoint, CheckpointStats, Validator staking state.
 * Tier 2 (ecrecover):    recover the exact signer set for every checkpoint from
 *                        the emitting submitCheckpoint tx calldata.
 *
 * Vote-hash scheme (verified against the deployed RootChain impl
 * 0x536c55cFe4892E581806e10b38dFE8083551bd03, maticnetwork/contracts @ eef53596):
 *
 *   submitCheckpoint(bytes data, uint256[3][] sigs)         selector 0x4e43e495
 *   data       = abi.encode(address proposer, uint256 start, uint256 end,
 *                           bytes32 rootHash, bytes32 accountHash, uint256 borChainId)
 *   voteHash   = keccak256(abi.encodePacked(bytes(hex"01"), data))   // 0x01 = "yes" vote
 *   each sig   = [r, s, v]  (v normalized: if v < 27 then v += 27)
 *   signers    = ecrecover(voteHash, v, r, s), required strictly ascending & unique
 *
 * Self-checked against checkpoint 105648 (tx 0x358f1b6e…): 102 sigs -> 102 unique
 * ascending signers, includes proposer 0x203847fb…, includes our signer 0xea105ab4….
 */
import { indexer, type Validator, type Signer } from "envio";
import {
  decodeFunctionData,
  keccak256,
  concat,
  recoverAddress,
  numberToHex,
  pad,
  type Hex,
} from "viem";

// Minimal ABI for decoding the emitting transaction's calldata.
const SUBMIT_CHECKPOINT_ABI = [
  {
    type: "function",
    name: "submitCheckpoint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "data", type: "bytes" },
      { name: "sigs", type: "uint256[3][]" },
    ],
    outputs: [],
  },
] as const;

const MAX_DEPOSITS = 10000n; // headerBlockId -> checkpointNumber divisor (verified)

// A signer that hasn't signed within this many checkpoints is considered to have
// left the active set and stops accruing "missed" counts. ~ACTIVE_WINDOW*30min.
const ACTIVE_WINDOW = 40n;

// ---------------------------------------------------------------------------
// Tier 2: recover the signer set from the submitCheckpoint calldata.
// Returns lowercase addresses in the order they appear in the sig blob.
// ---------------------------------------------------------------------------
async function recoverSigners(input: Hex): Promise<string[]> {
  const { functionName, args } = decodeFunctionData({
    abi: SUBMIT_CHECKPOINT_ABI,
    data: input,
  });
  if (functionName !== "submitCheckpoint") return [];

  const data = args[0] as Hex;
  const sigs = args[1] as readonly (readonly bigint[])[];

  // voteHash = keccak256(0x01 || data)
  const voteHash = keccak256(concat(["0x01", data]));

  const signers: string[] = [];
  for (const sig of sigs) {
    const r = pad(numberToHex(sig[0]), { size: 32 });
    const s = pad(numberToHex(sig[1]), { size: 32 });
    let v = Number(sig[2]);
    if (v < 27) v += 27; // ECVerify normalizes v
    const addr = await recoverAddress({
      hash: voteHash,
      signature: { r, s, v: BigInt(v) },
    });
    signers.push(addr.toLowerCase());
  }
  return signers;
}

// ---------------------------------------------------------------------------
// Entity default builders (upsert helpers).
// ---------------------------------------------------------------------------
function newValidator(validatorId: bigint): Validator {
  return {
    id: validatorId.toString(),
    validatorId,
    signer: undefined,
    jailed: false,
    lastJailedTimestamp: undefined,
    lastUnjailedTimestamp: undefined,
    totalSlashes: 0,
    currentStake: 0n,
    activationEpoch: undefined,
    deactivationEpoch: undefined,
    active: false,
    lastSignerChangeTimestamp: undefined,
    lastCheckpointSignedNumber: undefined,
    lastCheckpointSignedTimestamp: undefined,
    checkpointsSigned: 0,
    checkpointsMissed: 0,
  };
}

function newSigner(address: string): Signer {
  return {
    id: address,
    address,
    validatorId: undefined,
    checkpointsSigned: 0,
    checkpointsMissed: 0,
    firstCheckpointSignedNumber: undefined,
    lastCheckpointSignedNumber: undefined,
    lastCheckpointSignedTimestamp: undefined,
  };
}

// =========================================================================
// Tier 1 + Tier 2: RootChain.NewHeaderBlock
// =========================================================================
indexer.onEvent(
  { contract: "RootChain", event: "NewHeaderBlock" },
  async ({ event, context }) => {
    const headerBlockId = event.params.headerBlockId;
    const checkpointNumber = headerBlockId / MAX_DEPOSITS;
    const id = checkpointNumber.toString();
    const proposer = event.params.proposer.toLowerCase();
    const l1Block = BigInt(event.block.number);
    const ts = BigInt(event.block.timestamp);
    const txHash = event.transaction.hash;

    // --- Tier 2: recover signer set from calldata ---
    let signers: string[] = [];
    try {
      signers = await recoverSigners(event.transaction.input as Hex);
    } catch (e) {
      context.log.warn(
        `checkpoint ${id}: could not decode/recover signers from tx ${txHash}: ${e}`,
      );
    }

    // --- Checkpoint entity ---
    context.Checkpoint.set({
      id,
      checkpointNumber,
      headerBlockId,
      proposer,
      startBlock: event.params.start,
      endBlock: event.params.end,
      root: event.params.root,
      reward: event.params.reward,
      l1BlockNumber: l1Block,
      l1Timestamp: ts,
      txHash,
      signerCount: signers.length,
    });

    // --- CheckpointStats singleton ---
    const stats = await context.CheckpointStats.get("global");
    context.CheckpointStats.set({
      id: "global",
      latestCheckpointNumber: checkpointNumber,
      latestTimestamp: ts,
      latestProposer: proposer,
      latestL1BlockNumber: l1Block,
      totalCheckpoints: (stats?.totalCheckpoints ?? 0n) + 1n,
    });

    const signerSet = new Set(signers);

    // --- Per-signer signing records + CheckpointSignature rows ---
    for (const addr of signers) {
      const se = (await context.Signer.get(addr)) ?? newSigner(addr);
      context.Signer.set({
        ...se,
        checkpointsSigned: se.checkpointsSigned + 1,
        firstCheckpointSignedNumber:
          se.firstCheckpointSignedNumber ?? checkpointNumber,
        lastCheckpointSignedNumber: checkpointNumber,
        lastCheckpointSignedTimestamp: ts,
      });

      context.CheckpointSignature.set({
        id: `${id}-${addr}`,
        checkpoint_id: id,
        signerEntity_id: addr,
        signer: addr,
        validatorId: se.validatorId,
        checkpointNumber,
        l1Timestamp: ts,
      });

      // Mirror onto Validator when the signer->validatorId mapping is known.
      if (se.validatorId !== undefined) {
        const v = await context.Validator.get(se.validatorId.toString());
        if (v) {
          context.Validator.set({
            ...v,
            checkpointsSigned: v.checkpointsSigned + 1,
            lastCheckpointSignedNumber: checkpointNumber,
            lastCheckpointSignedTimestamp: ts,
          });
        }
      }
    }

    // --- Missed accounting over the recently-active signer set ---
    const setEnt = await context.ActiveSignerSet.get("global");
    const prev = setEnt?.signers ?? [];
    const nextSet = new Set<string>(prev);
    for (const addr of signers) nextSet.add(addr);

    for (const addr of prev) {
      if (signerSet.has(addr)) continue; // signed this checkpoint
      const se = await context.Signer.get(addr);
      if (!se || se.lastCheckpointSignedNumber === undefined) {
        nextSet.delete(addr);
        continue;
      }
      const gap = checkpointNumber - se.lastCheckpointSignedNumber;
      if (gap > 0n && gap <= ACTIVE_WINDOW) {
        // Was recently active but absent from this checkpoint's signer set.
        context.Signer.set({ ...se, checkpointsMissed: se.checkpointsMissed + 1 });
        if (se.validatorId !== undefined) {
          const v = await context.Validator.get(se.validatorId.toString());
          if (v) {
            context.Validator.set({
              ...v,
              checkpointsMissed: v.checkpointsMissed + 1,
            });
          }
        }
      } else if (gap > ACTIVE_WINDOW) {
        nextSet.delete(addr); // considered no longer active
      }
    }

    context.ActiveSignerSet.set({ id: "global", signers: Array.from(nextSet) });
  },
);

// =========================================================================
// Tier 1: StakingInfo validator lifecycle
// =========================================================================

// Link a signer address to its validatorId (bootstraps signer->validator resolution).
async function linkSigner(
  context: { Signer: { get: (id: string) => Promise<Signer | undefined>; set: (e: Signer) => void } },
  address: string,
  validatorId: bigint,
): Promise<void> {
  const se = (await context.Signer.get(address)) ?? newSigner(address);
  context.Signer.set({ ...se, validatorId });
}

indexer.onEvent(
  { contract: "StakingInfo", event: "Staked" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const signer = event.params.signer.toLowerCase();
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({
      ...v,
      signer,
      currentStake: event.params.total,
      activationEpoch: event.params.activationEpoch,
      active: true,
    });
    await linkSigner(context, signer, validatorId);
  },
);

indexer.onEvent(
  { contract: "StakingInfo", event: "Unstaked" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({
      ...v,
      currentStake: event.params.total,
      active: false,
    });
  },
);

indexer.onEvent(
  { contract: "StakingInfo", event: "StakeUpdate" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({ ...v, currentStake: event.params.newAmount });
  },
);

indexer.onEvent(
  { contract: "StakingInfo", event: "SignerChange" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const newSignerAddr = event.params.newSigner.toLowerCase();
    const ts = BigInt(event.block.timestamp);
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({
      ...v,
      signer: newSignerAddr,
      lastSignerChangeTimestamp: ts,
    });
    await linkSigner(context, newSignerAddr, validatorId);
  },
);

indexer.onEvent(
  { contract: "StakingInfo", event: "Jailed" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const signer = event.params.signer.toLowerCase();
    const ts = BigInt(event.block.timestamp);
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({
      ...v,
      signer,
      jailed: true,
      lastJailedTimestamp: ts,
      deactivationEpoch: event.params.exitEpoch,
    });
    await linkSigner(context, signer, validatorId);
  },
);

indexer.onEvent(
  { contract: "StakingInfo", event: "UnJailed" },
  async ({ event, context }) => {
    const validatorId = event.params.validatorId;
    const signer = event.params.signer.toLowerCase();
    const ts = BigInt(event.block.timestamp);
    const v =
      (await context.Validator.get(validatorId.toString())) ?? newValidator(validatorId);
    context.Validator.set({
      ...v,
      signer,
      jailed: false,
      lastUnjailedTimestamp: ts,
    });
    await linkSigner(context, signer, validatorId);
  },
);

// StakingInfo.Slashed(nonce, amount) is network-wide/aggregate — no validatorId,
// so it cannot be attributed to a single validator. Recorded globally.
indexer.onEvent(
  { contract: "StakingInfo", event: "Slashed" },
  async ({ event, context }) => {
    context.Slash.set({
      id: event.params.nonce.toString(),
      nonce: event.params.nonce,
      amount: event.params.amount,
      l1BlockNumber: BigInt(event.block.number),
      l1Timestamp: BigInt(event.block.timestamp),
      txHash: event.transaction.hash,
    });
  },
);
