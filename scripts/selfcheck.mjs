/**
 * Tier-2 self-check: prove the vote-hash + ecrecover derivation against a real
 * checkpoint's L1 transaction, independently of the running indexer.
 *
 *   node scripts/selfcheck.mjs [checkpointNumber]     (default: 105648)
 *
 * Verifies, for the recovered signer set:
 *   (a) includes the checkpoint proposer,
 *   (b) strictly ascending & unique,
 *   (d) reports whether OUR signer 0xea105ab4… is present.
 * (c) >2/3 stake is implied by the tx having been accepted on-chain.
 *
 * Uses the SAME derivation as src/EventHandlers.ts:
 *   voteHash = keccak256(0x01 ‖ data), each sig = [r, s, v] (v normalized).
 */
import {
  keccak256, toHex, pad, numberToHex, concat,
  decodeFunctionData, recoverAddress, decodeAbiParameters,
} from "viem";

const RPCS = [
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://ethereum-rpc.publicnode.com",
];
const ROOT = "0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287";
const TOPIC0 = keccak256(toHex("NewHeaderBlock(address,uint256,uint256,uint256,uint256,bytes32)"));
const OUR_SIGNER = "0xea105ab4e3f01f7f8da09cb84ab501aeb02e9fc7".toLowerCase();
const SUBMIT_ABI = [{
  type: "function", name: "submitCheckpoint",
  inputs: [{ name: "data", type: "bytes" }, { name: "sigs", type: "uint256[3][]" }],
}];

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const j = await r.json();
        if (j.error) throw new Error(JSON.stringify(j.error));
        return j.result;
      } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 400)); }
    }
  }
  throw lastErr;
}

const cp = BigInt(process.argv[2] ?? "105648");
const topic2 = pad(numberToHex(cp * 10000n));
const latest = parseInt(await rpc("eth_blockNumber", []), 16);

// scan back in 45-block windows (public-RPC friendly) for this checkpoint's log
let log = null;
for (let to = latest; to > latest - 12000 && !log; to -= 45) {
  const from = to - 44;
  try {
    const logs = await rpc("eth_getLogs", [{
      address: ROOT, fromBlock: numberToHex(from), toBlock: numberToHex(to),
      topics: [TOPIC0, null, topic2],
    }]);
    if (logs.length) log = logs[0];
  } catch { /* try next window */ }
}
if (!log) { console.error(`checkpoint ${cp} not found in last ~12k blocks`); process.exit(1); }

const proposer = ("0x" + log.topics[1].slice(26)).toLowerCase();
const tx = await rpc("eth_getTransactionByHash", [log.transactionHash]);
const { functionName, args } = decodeFunctionData({ abi: SUBMIT_ABI, data: tx.input });
if (functionName !== "submitCheckpoint") { console.error("unexpected fn", functionName); process.exit(1); }

const data = args[0], sigs = args[1];
const [dProposer, dStart, dEnd, , , dBor] = decodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }, { type: "uint256" },
   { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }], data);

const voteHash = keccak256(concat(["0x01", data]));
const recovered = [];
for (const sig of sigs) {
  const r = pad(numberToHex(sig[0]), { size: 32 });
  const s = pad(numberToHex(sig[1]), { size: 32 });
  let v = Number(sig[2]); if (v < 27) v += 27;
  recovered.push((await recoverAddress({ hash: voteHash, signature: { r, s, v: BigInt(v) } })).toLowerCase());
}

const uniq = new Set(recovered);
let ascending = true;
for (let i = 1; i < recovered.length; i++)
  if (!(BigInt(recovered[i]) > BigInt(recovered[i - 1]))) ascending = false;

console.log(`checkpoint ${cp}  L1 block ${parseInt(log.blockNumber, 16)}  tx ${log.transactionHash}`);
console.log(`data: proposer ${dProposer.toLowerCase()} start ${dStart} end ${dEnd} borChainId ${dBor}`);
console.log(`voteHash ${voteHash}`);
console.log(`signatures ${sigs.length}  recovered ${recovered.length}`);
console.log(`(a) includes proposer ${proposer}: ${uniq.has(proposer)}`);
console.log(`(b) strictly ascending & unique: ${ascending && uniq.size === recovered.length} (unique ${uniq.size})`);
console.log(`(d) OUR signer ${OUR_SIGNER} present: ${uniq.has(OUR_SIGNER)}`);

const pass = uniq.has(proposer) && ascending && uniq.size === recovered.length;
console.log(pass ? "\nSELF-CHECK PASSED ✅" : "\nSELF-CHECK FAILED ❌");
process.exit(pass ? 0 : 1);
