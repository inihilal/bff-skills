/**
 * hodlmm.ts -- HODLMM protocol integration
 *
 * Responsibilities:
 *  - Fetch current APR from HODLMM liquidity pools via Bitflow REST API
 *  - Get caller's LP positions (token amounts + accrued fees)
 *  - Add / remove liquidity (for rotation into/out of HODLMM)
 */

import axios from "axios";
import {
  makeContractCall,
  broadcastTransaction,
  AnchorMode,
  uintCV,
  principalCV,
  PostConditionMode,
  cvToJSON,
  hexToCV,
} from "@stacks/transactions";
import { StacksMainnet, StacksTestnet } from "@stacks/network";
import {
  HODLMM_CONTRACTS,
  HODLMM_DEPLOYER,
  BITFLOW_API_BASE,
  DEFAULT_HODLMM_POOL_ID,
  STACKS_PRIVATE_KEY,
  HIRO_API_KEY,
  getHiroApiUrl,
  type NetworkType,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HodlmmAPR {
  poolId: string;
  aprPct: number;
  feeRevenue24hUsd: number | null;
  tvlUsd: number | null;
  fetchedAt: string;
}

export interface HodlmmPosition {
  poolId: string;
  lpTokenBalanceRaw: bigint;
  lpTokenBalance: number;
  tokenAAmount: number;
  tokenBAmount: number;
  totalValueUsd: number | null;
  accruedFeesUsd: number | null;
}

export interface AddLiquidityResult {
  txid: string;
  poolId: string;
  amountA: number;
  amountB: number;
  dryRun: boolean;
}

export interface RemoveLiquidityResult {
  txid: string;
  poolId: string;
  lpTokenAmount: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNetwork(networkType: NetworkType) {
  return networkType === "mainnet" ? new StacksMainnet() : new StacksTestnet();
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (HIRO_API_KEY) headers["x-api-key"] = HIRO_API_KEY;
  return headers;
}

async function callReadOnly(
  network: NetworkType,
  contractAddress: string,
  contractName: string,
  functionName: string,
  args: string[] = []
): Promise<unknown> {
  const baseUrl = getHiroApiUrl(network);
  const url = `${baseUrl}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
  const body = { sender: HODLMM_DEPLOYER, arguments: args };
  const res = await axios.post(url, body, { headers: buildHeaders() });
  if (!res.data.okay) {
    throw new Error(`HODLMM read-only call failed: ${res.data.cause ?? "unknown"}`);
  }
  return cvToJSON(hexToCV(res.data.result));
}

// ---------------------------------------------------------------------------
// APR Fetching
// ---------------------------------------------------------------------------

interface BitflowPoolEntry {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  apr24h: number;
}
interface BitflowPoolsResponse {
  data: BitflowPoolEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function fetchHodlmmAPR(
  poolId = DEFAULT_HODLMM_POOL_ID,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _network: NetworkType = "mainnet"
): Promise<HodlmmAPR> {
  const url = `${BITFLOW_API_BASE}/api/app/v1/pools`;
  const res = await axios.get<BitflowPoolsResponse>(url, {
    timeout: 15_000,
    headers: { "Content-Type": "application/json" },
  });
  const pools = res.data.data ?? [];
  const pool = pools.find((p) => p.poolId === poolId);
  if (!pool) {
    const available = pools.map((p) => p.poolId).join(", ");
    throw new Error(
      `[HODLMM] Pool "${poolId}" not found. Available pools: ${available}`
    );
  }
  return {
    poolId: pool.poolId,
    aprPct: pool.apr24h,
    feeRevenue24hUsd: pool.volumeUsd1d ?? null,
    tvlUsd: pool.tvlUsd ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export async function getHodlmmPosition(
  poolId = "STX-USDh",
  address?: string,
  network: NetworkType = "mainnet"
): Promise<HodlmmPosition> {
  const walletAddress = address ?? process.env.STACKS_ADDRESS ?? "";
  const [contractAddress, contractName] = HODLMM_CONTRACTS.POOL.split(".");

  let lpTokenBalanceRaw = 0n;
  let tokenAAmount = 0;
  let tokenBAmount = 0;
  let totalValueUsd: number | null = null;
  let accruedFeesUsd: number | null = null;

  try {
    const pos = await callReadOnly(
      network,
      contractAddress,
      contractName,
      "get-position",
      [principalCV(walletAddress).toString()]
    ) as {
      value: {
        "lp-balance": { value: string };
        "token-a": { value: string };
        "token-b": { value: string };
        "fees-earned": { value: string };
      };
    };

    lpTokenBalanceRaw = BigInt(pos.value["lp-balance"].value);
    tokenAAmount = Number(pos.value["token-a"].value) / 1e6;
    tokenBAmount = Number(pos.value["token-b"].value) / 1e6;
    accruedFeesUsd = Number(pos.value["fees-earned"].value) / 1e6;
  } catch (err) {
    console.warn(`[HODLMM] Could not fetch position: ${(err as Error).message}`);
  }

  return {
    poolId,
    lpTokenBalanceRaw,
    lpTokenBalance: Number(lpTokenBalanceRaw) / 1e8,
    tokenAAmount,
    tokenBAmount,
    totalValueUsd,
    accruedFeesUsd,
  };
}

// ---------------------------------------------------------------------------
// Add Liquidity
// ---------------------------------------------------------------------------

export async function addLiquidity(
  poolId: string,
  amountA: number,
  amountB: number,
  dryRun = false,
  network: NetworkType = "mainnet"
): Promise<AddLiquidityResult> {
  const amountAMicro = BigInt(Math.floor(amountA * 1e6));
  const amountBMicro = BigInt(Math.floor(amountB * 1e6));

  console.log(
    `[HODLMM] ${dryRun ? "[DRY-RUN] " : ""}Adding liquidity to ${poolId}: ` +
    `${amountA} tokenA + ${amountB} tokenB`
  );

  if (dryRun) {
    return { txid: "dry-run-no-txid", poolId, amountA, amountB, dryRun: true };
  }

  const [contractAddress, contractName] = HODLMM_CONTRACTS.CORE.split(".");

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "add-liquidity",
    functionArgs: [uintCV(amountAMicro), uintCV(amountBMicro)],
    senderKey: STACKS_PRIVATE_KEY,
    network: getNetwork(network),
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const broadcastRes = await broadcastTransaction(tx, getNetwork(network));
  if (broadcastRes.error) {
    throw new Error(`Add liquidity broadcast failed: ${broadcastRes.error}`);
  }

  console.log(`[HODLMM] Add liquidity tx broadcast: ${broadcastRes.txid}`);
  return { txid: broadcastRes.txid, poolId, amountA, amountB, dryRun: false };
}

// ---------------------------------------------------------------------------
// Remove Liquidity
// ---------------------------------------------------------------------------

export async function removeLiquidity(
  poolId: string,
  lpTokenAmount: number,
  dryRun = false,
  network: NetworkType = "mainnet"
): Promise<RemoveLiquidityResult> {
  const lpMicro = BigInt(Math.floor(lpTokenAmount * 1e8));

  console.log(
    `[HODLMM] ${dryRun ? "[DRY-RUN] " : ""}Removing ${lpTokenAmount} LP tokens from ${poolId}`
  );

  if (dryRun) {
    return { txid: "dry-run-no-txid", poolId, lpTokenAmount, dryRun: true };
  }

  const [contractAddress, contractName] = HODLMM_CONTRACTS.CORE.split(".");

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "remove-liquidity",
    functionArgs: [uintCV(lpMicro)],
    senderKey: STACKS_PRIVATE_KEY,
    network: getNetwork(network),
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const broadcastRes = await broadcastTransaction(tx, getNetwork(network));
  if (broadcastRes.error) {
    throw new Error(`Remove liquidity broadcast failed: ${broadcastRes.error}`);
  }

  console.log(`[HODLMM] Remove liquidity tx broadcast: ${broadcastRes.txid}`);
  return { txid: broadcastRes.txid, poolId, lpTokenAmount, dryRun: false };
}
