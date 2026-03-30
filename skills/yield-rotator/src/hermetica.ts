/**
 * hermetica.ts -- Hermetica protocol integration
 *
 * Responsibilities:
 *  - Fetch current APY by sampling the sUSDh/USDh exchange rate on-chain
 *  - Stake USDh -> sUSDh via staking-v1-1
 *  - Unstake sUSDh -> USDh (initiates 7-day cooldown, returns claim-id)
 *  - Query current sUSDh position / balance
 */

import axios from "axios";
import {
  makeContractCall,
  broadcastTransaction,
  AnchorMode,
  uintCV,
  noneCV,
  cvToJSON,
  hexToCV,
  PostConditionMode,
  createStacksPrivateKey,
  getAddressFromPrivateKey,
  TransactionVersion,
} from "@stacks/transactions";
import { StacksMainnet, StacksTestnet } from "@stacks/network";
import {
  HERMETICA_CONTRACTS,
  HERMETICA_DEPLOYER,
  USDH_DECIMALS,
  SUSDH_DECIMALS,
  STACKS_PRIVATE_KEY,
  HIRO_API_KEY,
  getHiroApiUrl,
  type NetworkType,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HermeticaAPY {
  ratioRaw: bigint;
  ratio: number;
  estimatedApyPct: number | null;
  sampledAt: string;
}

export interface HermeticaPosition {
  sUsdhBalanceRaw: bigint;
  sUsdhBalance: number;
  usdhEquivalent: number;
}

export interface StakeResult {
  txid: string;
  amountUsdhMicro: bigint;
  dryRun: boolean;
}

export interface UnstakeResult {
  txid: string;
  claimId: bigint | null;
  amountSUsdhMicro: bigint;
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
  const body = { sender: HERMETICA_DEPLOYER, arguments: args };
  const res = await axios.post(url, body, { headers: buildHeaders() });
  if (!res.data.okay) {
    throw new Error(`Read-only call failed: ${res.data.cause ?? "unknown"}`);
  }
  return cvToJSON(hexToCV(res.data.result));
}

// ---------------------------------------------------------------------------
// APY Fetching
// ---------------------------------------------------------------------------

export async function fetchHermeticaRatio(
  network: NetworkType = "mainnet"
): Promise<HermeticaAPY> {
  const [contractAddress, contractName] = HERMETICA_CONTRACTS.STAKING.split(".");

  const result = await callReadOnly(
    network,
    contractAddress,
    contractName,
    "get-usdh-per-susdh"
  ) as { type: string; value: { type: string; value: string }; success: boolean };

  // cvToJSON wraps result in a (response uint) object -- extract the inner uint value
  const ratioRaw = BigInt(result.value.value);
  const ratio = Number(ratioRaw) / 1e8;

  return {
    ratioRaw,
    ratio,
    estimatedApyPct: null,
    sampledAt: new Date().toISOString(),
  };
}

export function computeApyFromRatios(
  earlier: HermeticaAPY,
  later: HermeticaAPY
): number {
  if (earlier.ratio === 0) throw new Error("Earlier ratio is zero, cannot compute APY");
  const hoursApart =
    (new Date(later.sampledAt).getTime() - new Date(earlier.sampledAt).getTime()) /
    (1000 * 60 * 60);
  if (hoursApart < 1) throw new Error("Samples must be at least 1 hour apart");
  const dailyYield = (later.ratio - earlier.ratio) / earlier.ratio * (24 / hoursApart);
  const apy = (Math.pow(1 + dailyYield, 365) - 1) * 100;
  return Math.max(0, apy);
}

export async function isStakingEnabled(network: NetworkType = "mainnet"): Promise<boolean> {
  const [addr, name] = HERMETICA_CONTRACTS.STAKING_STATE.split(".");
  const result = await callReadOnly(network, addr, name, "get-staking-enabled") as { value: boolean };
  return Boolean(result.value);
}

export async function getCooldownWindowSeconds(network: NetworkType = "mainnet"): Promise<number> {
  const [addr, name] = HERMETICA_CONTRACTS.STAKING_STATE.split(".");
  const result = await callReadOnly(network, addr, name, "get-cooldown-window") as { value: string };
  return Number(String(result.value));
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export async function getHermeticaPosition(
  network: NetworkType = "mainnet",
  address?: string
): Promise<HermeticaPosition> {
  const walletAddress = address ?? getAddressFromPrivateKey(
    STACKS_PRIVATE_KEY,
    network === "mainnet" ? TransactionVersion.Mainnet : TransactionVersion.Testnet
  );
  const baseUrl = getHiroApiUrl(network);
  const [, tokenName] = HERMETICA_CONTRACTS.SUSDH_TOKEN.split(".");

  const res = await axios.get(
    `${baseUrl}/extended/v1/address/${walletAddress}/balances`,
    { headers: buildHeaders() }
  );

  const fungibleTokens = res.data.fungible_tokens as Record<string, { balance: string }>;
  const sUsdhKey = `${HERMETICA_CONTRACTS.SUSDH_TOKEN}::${tokenName}`;
  const sUsdhRaw = BigInt(fungibleTokens[sUsdhKey]?.balance ?? "0");
  const sUsdhBalance = Number(sUsdhRaw) / Math.pow(10, SUSDH_DECIMALS);

  const ratioData = await fetchHermeticaRatio(network);
  const usdhEquivalent = sUsdhBalance * ratioData.ratio;

  return {
    sUsdhBalanceRaw: sUsdhRaw,
    sUsdhBalance,
    usdhEquivalent,
  };
}

// ---------------------------------------------------------------------------
// Stake
// ---------------------------------------------------------------------------

export async function stakeUsdh(
  amountUsdh: number,
  dryRun = false,
  network: NetworkType = "mainnet"
): Promise<StakeResult> {
  const amountMicro = BigInt(Math.floor(amountUsdh * Math.pow(10, USDH_DECIMALS)));

  console.log(
    `[Hermetica] ${dryRun ? "[DRY-RUN] " : ""}Staking ${amountUsdh} USDh (${amountMicro} micro)...`
  );

  if (dryRun) {
    return { txid: "dry-run-no-txid", amountUsdhMicro: amountMicro, dryRun: true };
  }

  const [contractAddress, contractName] = HERMETICA_CONTRACTS.STAKING.split(".");
  createStacksPrivateKey(STACKS_PRIVATE_KEY);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "stake",
    functionArgs: [uintCV(amountMicro), noneCV()],
    senderKey: STACKS_PRIVATE_KEY,
    network: getNetwork(network),
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const broadcastRes = await broadcastTransaction(tx, getNetwork(network));
  if (broadcastRes.error) {
    throw new Error(`Stake broadcast failed: ${broadcastRes.error}`);
  }

  console.log(`[Hermetica] Stake tx broadcast: ${broadcastRes.txid}`);
  return { txid: broadcastRes.txid, amountUsdhMicro: amountMicro, dryRun: false };
}

// ---------------------------------------------------------------------------
// Unstake
// ---------------------------------------------------------------------------

export async function unstakeSUsdh(
  amountSUsdh: number,
  dryRun = false,
  network: NetworkType = "mainnet"
): Promise<UnstakeResult> {
  const amountMicro = BigInt(Math.floor(amountSUsdh * Math.pow(10, SUSDH_DECIMALS)));

  console.log(
    `[Hermetica] ${dryRun ? "[DRY-RUN] " : ""}Unstaking ${amountSUsdh} sUSDh (${amountMicro} micro)...`
  );
  console.log(`[Hermetica] WARNING: Unstake has a 7-day cooldown before USDh can be claimed.`);

  if (dryRun) {
    return { txid: "dry-run-no-txid", claimId: null, amountSUsdhMicro: amountMicro, dryRun: true };
  }

  const [contractAddress, contractName] = HERMETICA_CONTRACTS.STAKING.split(".");

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "unstake",
    functionArgs: [uintCV(amountMicro)],
    senderKey: STACKS_PRIVATE_KEY,
    network: getNetwork(network),
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const broadcastRes = await broadcastTransaction(tx, getNetwork(network));
  if (broadcastRes.error) {
    throw new Error(`Unstake broadcast failed: ${broadcastRes.error}`);
  }

  console.log(`[Hermetica] Unstake tx broadcast: ${broadcastRes.txid}`);

  return {
    txid: broadcastRes.txid,
    claimId: null,
    amountSUsdhMicro: amountMicro,
    dryRun: false,
  };
}
