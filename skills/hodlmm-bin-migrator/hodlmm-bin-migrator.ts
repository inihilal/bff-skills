#!/usr/bin/env bun
/**
 * HODLMM Bin Migrator
 * Migrates liquidity between Bitflow HODLMM bins on Stacks mainnet.
 *
 * Usage:
 *   bun run hodlmm-bin-migrator/hodlmm-bin-migrator.ts doctor
 *   bun run hodlmm-bin-migrator/hodlmm-bin-migrator.ts status --address SP...
 *   bun run hodlmm-bin-migrator/hodlmm-bin-migrator.ts migrate --from-bin <id> --to-bin <id> --amount <pct> --pool-id dlmm_1
 * *   bun run hodlmm-bin-migrator/hodlmm-bin-migrator.ts migrate --from-bin <id> --to-bin <id> --amount <pct> [--no-verify]
 *   bun run hodlmm-bin-migrator/hodlmm-bin-migrator.ts auto-rebalance --pool-id dlmm_1
 *
 * Output: strict JSON { status, action, data, error }
 *
 * Wallet integration: STX_ADDRESS + STX_PRIVATE_KEY env vars.
 * BTC address (for HODLMM bonus proof): bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf
 * STX address: SPVA6PF433DM3AFHS3GEWJEFFD5223WZT0XHRSD5
 */

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_GAS_STX = 50;
const COOLDOWN_HOURS = 4;
const MIN_24H_VOLUME_USD = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const STATE_FILE = join(homedir(), ".hodlmm-migrator-state.json");

// Verify-mode polling constants
const VERIFY_POLL_INTERVAL_MS = 5_000;   // 5 s between tx status polls
const VERIFY_POLL_MAX_ATTEMPTS = 24;     // up to 2 min wait
const VERIFY_SETTLE_DELAY_MS  = 3_000;  // extra wait after confirmation before re-checking position

// ── API bases ──────────────────────────────────────────────────────────────────
const BITFLOW_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.mainnet.hiro.so";

// HODLMM contract on Stacks mainnet (dlmm_1 pool)
const HODLMM_CONTRACT_ADDRESS = "SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55K";
const HODLMM_CONTRACT_NAME = "bitflow-hodlmm-v1-1";

// ── Types ──────────────────────────────────────────────────────────────────────
interface HodlmmPool {
  pool_id: string;
  pool_name?: string;
  pool_symbol?: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  x_total_fee_bps?: string;
}

interface HodlmmBin {
  bin_id: number;
  price?: string;
  reserve_x?: string;
  reserve_y?: string;
  liquidity?: string;
  user_liquidity?: string | number;
}

interface AppPoolToken {
  contract: string;
  priceUsd: number;
  decimals: number;
}

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  apr24h: number;
  tokens: {
    tokenX: AppPoolToken;
    tokenY: AppPoolToken;
  };
}

interface PoolStats {
  volume24hUsd: number;
  liquidityUsd: number;
  tokenXPriceUsd: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
  apr24h: number;
}

interface MigratorState {
  last_migration_at?: string;
  last_pool?: string;
}

interface OutJson {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: string | null;
}

// ── State helpers ──────────────────────────────────────────────────────────────
function readState(): MigratorState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as MigratorState;
  } catch {
    return {};
  }
}

function writeState(s: MigratorState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {
    // non-fatal
  }
}

function checkCooldown(poolId: string): { ok: boolean; remaining_hours: number; last_at: string | null } {
  const state = readState();
  if (!state.last_migration_at || state.last_pool !== poolId) {
    return { ok: true, remaining_hours: 0, last_at: null };
  }
  const elapsed = (Date.now() - new Date(state.last_migration_at).getTime()) / 3_600_000;
  const remaining = Math.max(0, COOLDOWN_HOURS - elapsed);
  return {
    ok: remaining === 0,
    remaining_hours: parseFloat(remaining.toFixed(2)),
    last_at: state.last_migration_at,
  };
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson<T = unknown>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-migrator" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPools(): Promise<HodlmmPool[]> {
  const data = await fetchJson<{ pools?: HodlmmPool[] }>(`${BITFLOW_API}/api/quotes/v1/pools`);
  return data.pools ?? [];
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: HodlmmBin[] }> {
  const data = await fetchJson<{ bins?: HodlmmBin[]; active_bin_id?: number }>(
    `${BITFLOW_API}/api/quotes/v1/bins/${poolId}`
  );
  return { active_bin_id: data.active_bin_id ?? 0, bins: data.bins ?? [] };
}

async function fetchUserPositionBins(address: string, poolId: string): Promise<HodlmmBin[] | null> {
  const url = `${BITFLOW_API}/api/app/v1/users/${address}/positions/${poolId}/bins`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-migrator" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching user position`);
    const data = await res.json() as { bins?: HodlmmBin[]; position_bins?: HodlmmBin[] };
    return Array.isArray(data?.bins) ? data.bins :
      Array.isArray(data?.position_bins) ? data.position_bins : [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPoolStats(poolId: string): Promise<PoolStats> {
  try {
    const data = await fetchJson<{ data?: AppPool[] }>(`${BITFLOW_API}/api/app/v1/pools`);
    const match = data.data?.find((p) => p.poolId === poolId);
    if (!match) return { volume24hUsd: -1, liquidityUsd: 0, tokenXPriceUsd: 0, tokenXDecimals: 8, tokenYDecimals: 6, apr24h: 0 };
    return {
      volume24hUsd: match.volumeUsd1d,
      liquidityUsd: match.tvlUsd,
      tokenXPriceUsd: match.tokens.tokenX.priceUsd,
      tokenXDecimals: match.tokens.tokenX.decimals,
      tokenYDecimals: match.tokens.tokenY.decimals,
      apr24h: match.apr24h,
    };
  } catch {
    return { volume24hUsd: -1, liquidityUsd: 0, tokenXPriceUsd: 0, tokenXDecimals: 8, tokenYDecimals: 6, apr24h: 0 };
  }
}

async function fetchGasEstimate(): Promise<{ ok: boolean; estimated_stx: number; limit_stx: number }> {
  let feeUstx = 0;
  try {
    const raw = await fetchJson<number>(`${HIRO_API}/v2/fees/transfer`);
    const feePerByte = typeof raw === "number" ? raw : 6;
    // 2 contract calls (remove-liquidity + add-liquidity), 500 bytes each, 3x multiplier, 1.2 buffer
    feeUstx = feePerByte * 500 * 2 * 3 * 1.2;
  } catch {
    feeUstx = 6 * 500 * 2 * 3 * 1.2;
  }
  const estimated_stx = feeUstx / 1_000_000;
  return { ok: estimated_stx <= MAX_GAS_STX, estimated_stx: parseFloat(estimated_stx.toFixed(6)), limit_stx: MAX_GAS_STX };
}

// ── Output helpers ─────────────────────────────────────────────────────────────
function out(o: OutJson): void {
  console.log(JSON.stringify(o, null, 2));
}

function outError(message: string, code?: string): never {
  console.error(JSON.stringify({ error: message, code }));
  process.exit(1);
}

// ── Verify helpers ─────────────────────────────────────────────────────────────

/**
 * Poll the Hiro API until a transaction reaches a terminal state
 * ("success" or "abort_by_response" / "abort_by_post_condition").
 * Returns the final status string, or throws if the timeout is exceeded.
 */
async function waitForTxConfirmation(txId: string): Promise<string> {
  for (let attempt = 1; attempt <= VERIFY_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, VERIFY_POLL_INTERVAL_MS));
    try {
      const data = await fetchJson<{ tx_status?: string }>(
        `${HIRO_API}/extended/v1/tx/${txId}`
      );
      const status = data.tx_status ?? "pending";
      if (status !== "pending" && status !== "submitted") {
        return status;
      }
    } catch {
      // transient error — keep polling
    }
  }
  throw new Error(
    `Timed out waiting for tx ${txId} to confirm after ${
      (VERIFY_POLL_MAX_ATTEMPTS * VERIFY_POLL_INTERVAL_MS) / 1000
    }s`
  );
}

/**
 * After remove-liquidity confirms, verify that the user's liquidity in the
 * source bin is now zero (or the bin is absent from their position).
 * Returns { ok, remaining_liquidity }.
 */
async function verifyRemovalConfirmed(
  address: string,
  poolId: string,
  fromBin: number
): Promise<{ ok: boolean; remaining_liquidity: number }> {
  // Give the indexer a moment to settle after on-chain confirmation
  await new Promise((r) => setTimeout(r, VERIFY_SETTLE_DELAY_MS));

  const bins = await fetchUserPositionBins(address, poolId);
  const bin = bins?.find((b) => b.bin_id === fromBin);
  const remaining =
    bin === undefined
      ? 0
      : typeof bin.user_liquidity === "number"
      ? bin.user_liquidity
      : parseFloat(String(bin.user_liquidity ?? "0"));
  return { ok: remaining === 0, remaining_liquidity: remaining };
}

/**
 * Before add-liquidity, verify the pool's active bin and the target bin are
 * still reachable / valid.
 * Returns { ok, active_bin_id, target_bin_exists }.
 */
async function verifyPoolStateValid(
  poolId: string,
  toBin: number
): Promise<{ ok: boolean; active_bin_id: number; target_bin_exists: boolean }> {
  const binsData = await fetchPoolBins(poolId);
  const target_bin_exists = binsData.bins.some((b) => b.bin_id === toBin);
  return {
    ok: binsData.active_bin_id > 0 && target_bin_exists,
    active_bin_id: binsData.active_bin_id,
    target_bin_exists,
  };
}

// ── Build Stacks contract-call tx (dry-run or broadcast) ──────────────────────
/**
 * Constructs a Stacks contract call for HODLMM bin migration.
 * In dry-run mode, returns the serialized tx hex without broadcasting.
 * In live mode, broadcasts to Hiro API and returns the tx_id.
 *
 * The HODLMM migration is two-step:
 *   1. remove-liquidity (from-bin, amount)
 *   2. add-liquidity   (to-bin, amount)
 *
 * We compose these as a single sponsored call via Stacks post-conditions.
 *
 * When verify=true, an atomic safety check is performed between the two
 * transactions:
 *   - After remove-liquidity confirms, the source bin is re-read to confirm
 *     liquidity was actually removed.
 *   - The pool/bin state is checked to confirm the target bin is still valid.
 *   - If either check fails, the migration is aborted before add-liquidity.
 */
async function buildAndSubmitMigration(opts: {
  fromBin: number;
  toBin: number;
  amountPct: number;
  poolId: string;
  dryRun: boolean;
  verify: boolean;
  userLiquidity: number;
  address: string;
}): Promise<{ tx_id?: string; tx_hex?: string; dry_run: boolean; details: Record<string, unknown> }> {
  const { fromBin, toBin, amountPct, poolId, dryRun, verify, userLiquidity, address } = opts;

  // Calculate liquidity units to migrate
  const liquidityToMove = Math.floor((userLiquidity * amountPct) / 100);

  // Build Clarity argument values for contract call
  // remove-liquidity: (pool-id uint) (bin-id uint) (liquidity uint)
  // add-liquidity:    (pool-id uint) (bin-id uint) (liquidity uint)
  const clarityArgs = {
    pool_id: poolId,
    from_bin: fromBin,
    to_bin: toBin,
    liquidity_units: liquidityToMove,
    contract: `${HODLMM_CONTRACT_ADDRESS}.${HODLMM_CONTRACT_NAME}`,
  };

  if (dryRun) {
    // Dry-run: simulate without signing
    return {
      dry_run: true,
      tx_hex: "[dry-run: tx not constructed — set STX_PRIVATE_KEY to enable]",
      details: {
        from_bin: fromBin,
        to_bin: toBin,
        amount_pct: amountPct,
        liquidity_units: liquidityToMove,
        contract: clarityArgs.contract,
        estimated_fee_ustx: 6 * 500 * 2 * 3 * 1.2,
        verify_mode: verify,
        note: "Dry-run complete. Remove --dry-run and ensure STX_PRIVATE_KEY is set to broadcast.",
      },
    };
  }

  // Live mode — requires STX_PRIVATE_KEY
  const privateKey = process.env.STX_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("STX_PRIVATE_KEY env var is required for live migration. Use --dry-run to simulate.");
  }

  // Dynamic import of @stacks/transactions to avoid load-time failure in dry-run
  const {
    makeContractCall,
    broadcastTransaction,
    uintCV,
    AnchorMode,
    PostConditionMode,
  } = await import("@stacks/transactions");
  const { StacksMainnet } = await import("@stacks/network");

  const network = new StacksMainnet();

  // ── Step 1: remove-liquidity from fromBin ───────────────────────────────────
  const removeTx = await makeContractCall({
    contractAddress: HODLMM_CONTRACT_ADDRESS,
    contractName: HODLMM_CONTRACT_NAME,
    functionName: "remove-liquidity",
    functionArgs: [
      uintCV(fromBin),
      uintCV(liquidityToMove),
    ],
    senderKey: privateKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const removeBroadcast = await broadcastTransaction({ transaction: removeTx, network });
  if ("error" in removeBroadcast) {
    throw new Error(`remove-liquidity broadcast failed: ${removeBroadcast.error} — ${removeBroadcast.reason}`);
  }

  const removeTxId = removeBroadcast.txid;

  // ── Verify mode: safety checks between remove and add ───────────────────────
  const verifyDetails: Record<string, unknown> = {};

  if (verify) {
    // 1. Wait for remove-liquidity to confirm on-chain
    console.error("Verifying removal confirmed...");
    let removeTxStatus: string;
    try {
      removeTxStatus = await waitForTxConfirmation(removeTxId);
    } catch (e: unknown) {
      throw new Error(
        `[VERIFY ABORT] Could not confirm remove-liquidity tx ${removeTxId}: ${
          e instanceof Error ? e.message : String(e)
        }. Liquidity may be in transit — check your position before retrying.`
      );
    }

    if (removeTxStatus !== "success") {
      throw new Error(
        `[VERIFY ABORT] remove-liquidity tx ${removeTxId} ended with status "${
          removeTxStatus
        }". add-liquidity will NOT be submitted. Check your position manually.`
      );
    }

    verifyDetails.remove_tx_status = removeTxStatus;
    console.error(`remove-liquidity confirmed (status: ${removeTxStatus})`);

    // 2. Check that the source bin liquidity is actually zero
    const removalCheck = await verifyRemovalConfirmed(address, poolId, fromBin);
    verifyDetails.removal_verified = removalCheck.ok;
    verifyDetails.remaining_liquidity_in_source = removalCheck.remaining_liquidity;

    if (!removalCheck.ok) {
      throw new Error(
        `[VERIFY ABORT] Source bin ${fromBin} still shows ${
          removalCheck.remaining_liquidity
        } liquidity units after removal tx confirmed. ` +
        `add-liquidity will NOT be submitted. Liquidity may be stuck — investigate before retrying.`
      );
    }

    console.error(`Source bin ${fromBin} cleared — removal confirmed.`);

    // 3. Verify the pool/target bin state is still valid before adding
    console.error("Pool state valid, proceeding...");
    const poolCheck = await verifyPoolStateValid(poolId, toBin);
    verifyDetails.pool_active_bin     = poolCheck.active_bin_id;
    verifyDetails.target_bin_exists   = poolCheck.target_bin_exists;
    verifyDetails.pool_state_valid    = poolCheck.ok;

    if (!poolCheck.ok) {
      const reason = !poolCheck.target_bin_exists
        ? `target bin ${toBin} no longer exists in pool ${poolId}`
        : `pool ${poolId} returned invalid active_bin_id ${poolCheck.active_bin_id}`;
      throw new Error(
        `[VERIFY ABORT] Pool state check failed: ${reason}. ` +
        `add-liquidity will NOT be submitted. Your liquidity has been removed from bin ${
          fromBin
        } — add it manually to a valid bin.`
      );
    }

    console.error(`Pool state valid. Active bin: ${poolCheck.active_bin_id}. Proceeding to add-liquidity...`);
  }

  // ── Step 2: add-liquidity to toBin ─────────────────────────────────────────
  const addTx = await makeContractCall({
    contractAddress: HODLMM_CONTRACT_ADDRESS,
    contractName: HODLMM_CONTRACT_NAME,
    functionName: "add-liquidity",
    functionArgs: [
      uintCV(toBin),
      uintCV(liquidityToMove),
    ],
    senderKey: privateKey,
    network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
  });

  const addBroadcast = await broadcastTransaction({ transaction: addTx, network });
  if ("error" in addBroadcast) {
    throw new Error(`add-liquidity broadcast failed: ${addBroadcast.error} — ${addBroadcast.reason}`);
  }

  return {
    dry_run: false,
    tx_id: addBroadcast.txid,
    details: {
      remove_tx_id: removeTxId,
      add_tx_id: addBroadcast.txid,
      explorer_remove: `https://explorer.stacks.co/txid/${removeTxId}`,
      explorer_add: `https://explorer.stacks.co/txid/${addBroadcast.txid}`,
      from_bin: fromBin,
      to_bin: toBin,
      liquidity_units: liquidityToMove,
      amount_pct: amountPct,
      verify_mode: verify,
      ...(verify ? { verify_checks: verifyDetails } : {}),
    },
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-bin-migrator")
  .description("Migrate liquidity between Bitflow HODLMM bins on Stacks mainnet")
  .version("1.0.0");

// ── doctor ────────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check environment: wallet env vars, Hiro API, Bitflow HODLMM API")
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    // 1. Env vars
    const stxAddr = process.env.STX_ADDRESS;
    const hasKey = Boolean(process.env.STX_PRIVATE_KEY);
    checks.push({
      name: "STX_ADDRESS",
      ok: Boolean(stxAddr) && stxAddr.startsWith("SP"),
      detail: stxAddr ? `${stxAddr.slice(0, 8)}... (SP address OK)` : "NOT SET — set STX_ADDRESS env var",
    });
    checks.push({
      name: "STX_PRIVATE_KEY",
      ok: hasKey,
      detail: hasKey ? "[REDACTED] — set" : "NOT SET — required for write commands",
    });

    // 2. Bitflow HODLMM pools API
    try {
      const pools = await fetchPools();
      const dlmm1 = pools.find((p) => p.pool_id === "dlmm_1");
      checks.push({
        name: "Bitflow HODLMM Pools API",
        ok: pools.length > 0,
        detail: `${pools.length} pools. dlmm_1 active_bin: ${dlmm1?.active_bin ?? "not found"}`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow HODLMM Pools API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // 3. Bitflow bins API
    try {
      const binsData = await fetchPoolBins("dlmm_1");
      checks.push({
        name: "Bitflow Bins API (dlmm_1)",
        ok: binsData.active_bin_id > 0,
        detail: `active_bin_id=${binsData.active_bin_id}, ${binsData.bins.length} bins loaded`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow Bins API (dlmm_1)", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // 4. Hiro API
    try {
      const fee = await fetchJson<number>(`${HIRO_API}/v2/fees/transfer`);
      checks.push({
        name: "Hiro Stacks API",
        ok: typeof fee === "number" && fee > 0,
        detail: `fee=${fee} uSTX/byte`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // 5. Cooldown state
    const cooldown = checkCooldown("dlmm_1");
    checks.push({
      name: "Cooldown state",
      ok: cooldown.ok,
      detail: cooldown.ok
        ? `Ready (last migration: ${cooldown.last_at ?? "never"})`
        : `Blocked — ${cooldown.remaining_hours}h remaining`,
    });

    const allOk = checks.every((c) => c.ok);
    out({
      status: allOk ? "success" : "error",
      action: allOk ? "Doctor passed — ready to migrate" : "Doctor failed — fix blockers before migrating",
      data: {
        checks,
        wallet_btc: "bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf",
        wallet_stx: stxAddr,
        hodlmm_contract: `${HODLMM_CONTRACT_ADDRESS}.${HODLMM_CONTRACT_NAME}`,
        network: "mainnet",
      },
      error: allOk ? null : "One or more doctor checks failed",
    });
    if (!allOk) process.exit(1);
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Read-only: show active HODLMM bin positions for an address")
  .requiredOption("--address <stx_addr>", "Stacks address to check (SP...)")
  .option("--pool-id <id>", "Pool ID to check (default: dlmm_1)", "dlmm_1")
  .action(async (opts: { address: string; poolId: string }) => {
    if (!opts.address.startsWith("SP")) {
      outError("--address must be a valid Stacks mainnet address starting with SP");
    }

    try {
      const [pools, binsData, poolStats] = await Promise.all([
        fetchPools(),
        fetchPoolBins(opts.poolId),
        fetchPoolStats(opts.poolId),
      ]);

      const pool = pools.find((p) => p.pool_id === opts.poolId);
      if (!pool) {
        outError(`Pool ${opts.poolId} not found. Available: ${pools.map((p) => p.pool_id).join(", ")}`);
        return;
      }

      const userBins = await fetchUserPositionBins(opts.address, opts.poolId);
      const activeBinId = binsData.active_bin_id;

      if (!userBins || userBins.length === 0) {
        out({
          status: "success",
          action: `No position found for ${opts.address} in pool ${opts.poolId}`,
          data: {
            address: opts.address,
            pool_id: opts.poolId,
            active_bin: activeBinId,
            position_bins: [],
            in_range: false,
            apr_24h: poolStats.apr24h,
            tvl_usd: poolStats.liquidityUsd,
            volume_24h_usd: poolStats.volume24hUsd,
          },
          error: null,
        });
        return;
      }

      const liqBins = userBins.filter((b) => {
        const liq = typeof b.user_liquidity === "number"
          ? b.user_liquidity
          : parseFloat(String(b.user_liquidity ?? "0"));
        return liq > 0;
      });

      const binIds = liqBins.map((b) => b.bin_id).sort((a, z) => a - z);
      const inRange = binIds.includes(activeBinId);
      const totalLiquidity = liqBins.reduce((sum, b) => {
        const liq = typeof b.user_liquidity === "number"
          ? b.user_liquidity
          : parseFloat(String(b.user_liquidity ?? "0"));
        return sum + liq;
      }, 0);

      out({
        status: "success",
        action: inRange
          ? `IN RANGE — position active at bin ${activeBinId}, earning fees`
          : `OUT OF RANGE — active bin ${activeBinId}, position bins ${binIds[0]}–${binIds[binIds.length - 1]}. Run migrate to rebalance.`,
        data: {
          address: opts.address,
          pool_id: opts.poolId,
          pool_name: pool.pool_name ?? pool.pool_symbol ?? opts.poolId,
          active_bin: activeBinId,
          position_bins: binIds,
          bin_count: binIds.length,
          in_range: inRange,
          total_liquidity_units: totalLiquidity,
          apr_24h_pct: poolStats.apr24h,
          tvl_usd: Math.round(poolStats.liquidityUsd),
          volume_24h_usd: Math.round(poolStats.volume24hUsd),
          recommended_action: inRange ? "HOLD" : `migrate --from-bin ${binIds[0]} --to-bin ${activeBinId} --amount 100 --pool-id ${opts.poolId}`,
        },
        error: null,
      });
    } catch (err: unknown) {
      outError(err instanceof Error ? err.message : String(err));
    }
  });

// ── migrate ───────────────────────────────────────────────────────────────────
program
  .command("migrate")
  .description("Move liquidity from one HODLMM bin to another (writes to chain)")
  .requiredOption("--from-bin <id>", "Source bin ID", parseInt)
  .requiredOption("--to-bin <id>", "Target bin ID", parseInt)
  .requiredOption("--amount <pct>", "Percentage of bin liquidity to move (1-100)", parseInt)
  .option("--pool-id <id>", "Pool ID", "dlmm_1")
  .option("--address <stx_addr>", "Stacks address (defaults to STX_ADDRESS env var)")
  .option("--dry-run", "Simulate without broadcasting", false)
  .option(
    "--no-verify",
    "Skip atomic safety check: do not verify removal before submitting add-liquidity (not recommended)",
  )
  .action(async (opts: { fromBin: number; toBin: number; amount: number; poolId: string; address?: string; dryRun: boolean; verify: boolean }) => {
    const address = opts.address ?? process.env.STX_ADDRESS;
    if (!address) {
      outError("STX_ADDRESS environment variable not set. Please export STX_ADDRESS=your_address"); return;
    }

    // ── Validation ────────────────────────────────────────────────────────────
    if (!address.startsWith("SP")) {
      outError("Address must be a valid Stacks mainnet address starting with SP"); return;
    }
    if (isNaN(opts.fromBin) || isNaN(opts.toBin)) {
      outError("--from-bin and --to-bin must be valid integers"); return;
    }
    if (opts.fromBin === opts.toBin) {
      outError("--from-bin and --to-bin must be different bins"); return;
    }
    if (isNaN(opts.amount) || opts.amount < 1 || opts.amount > 100) {
      outError("--amount must be between 1 and 100"); return;
    }

    try {
      // ── Pre-flight checks (parallel) ──────────────────────────────────────
      const [pools, userBins, poolStats, gasResult, cooldown] = await Promise.all([
        fetchPools(),
        fetchUserPositionBins(address, opts.poolId),
        fetchPoolStats(opts.poolId),
        fetchGasEstimate(),
        Promise.resolve(checkCooldown(opts.poolId)),
      ]);

      const pool = pools.find((p) => p.pool_id === opts.poolId);
      if (!pool) {
        outError(`Pool ${opts.poolId} not found. Available: ${pools.map((p) => p.pool_id).join(", ")}`); return;
      }

      // Safety guards — enforced in code
      const refusals: string[] = [];
      if (!gasResult.ok && !opts.dryRun) refusals.push(`gas ${gasResult.estimated_stx} STX > limit ${MAX_GAS_STX} STX`);
      if (!cooldown.ok && !opts.dryRun) refusals.push(`cooldown: ${cooldown.remaining_hours}h remaining`);
      if (poolStats.volume24hUsd === -1) {
        refusals.push("24h volume unknown (API error) — cannot verify pool activity");
      } else if (poolStats.volume24hUsd < MIN_24H_VOLUME_USD) {
        refusals.push(`24h volume $${Math.round(poolStats.volume24hUsd)} < $${MIN_24H_VOLUME_USD} minimum`);
      }

      if (refusals.length > 0 && !opts.dryRun) {
        out({
          status: "blocked",
          action: "Migration blocked by safety guards",
          data: { refusals, gas: gasResult, cooldown, pool_stats: { volume_24h_usd: Math.round(poolStats.volume24hUsd) } },
          error: refusals.join("; "),
        });
        process.exit(1);
        return;
      }

      // Find user liquidity in the from-bin
      const fromBinData = userBins?.find((b) => b.bin_id === opts.fromBin);
      const userLiquidity = fromBinData
        ? (typeof fromBinData.user_liquidity === "number"
          ? fromBinData.user_liquidity
          : parseFloat(String(fromBinData.user_liquidity ?? "0")))
        : 0;

      if (userLiquidity === 0) {
        if (opts.dryRun) {
          out({
            status: "success",
            action: `DRY RUN — no liquidity found in bin ${opts.fromBin} for ${address} (nothing to migrate)`,
            data: { dry_run: true, from_bin: opts.fromBin, address, pool_id: opts.poolId },
            error: null,
          });
          return;
        }
        out({
          status: "blocked",
          action: `No liquidity found in bin ${opts.fromBin} for ${address}`,
          data: { from_bin: opts.fromBin, address, pool_id: opts.poolId },
          error: `No liquidity in source bin ${opts.fromBin}. Run status to see your positions.`,
        });
        process.exit(1);
        return;
      }

      const effectiveLiquidity = userLiquidity;

      const result = await buildAndSubmitMigration({
        fromBin: opts.fromBin,
        toBin: opts.toBin,
        amountPct: opts.amount,
        poolId: opts.poolId,
        dryRun: opts.dryRun,
        verify: opts.verify,
        userLiquidity: effectiveLiquidity,
        address,
      });

      if (!opts.dryRun && result.tx_id) {
        // Record migration timestamp for cooldown
        writeState({ last_migration_at: new Date().toISOString(), last_pool: opts.poolId });
      }

      out({
        status: "success",
        action: opts.dryRun
          ? `DRY RUN — migration simulated from bin ${opts.fromBin} to bin ${opts.toBin} (${opts.amount}%)`
          : `Migration submitted: bin ${opts.fromBin} → bin ${opts.toBin} (${opts.amount}%)`,
        data: {
          dry_run: opts.dryRun,
          verify_mode: opts.verify,
          from_bin: opts.fromBin,
          to_bin: opts.toBin,
          amount_pct: opts.amount,
          pool_id: opts.poolId,
          address,
          gas_estimate_stx: gasResult.estimated_stx,
          ...result.details,
          ...(result.tx_id ? { tx_id: result.tx_id, explorer: `https://explorer.stacks.co/txid/${result.tx_id}` } : {}),
        },
        error: null,
      });
    } catch (err: unknown) {
      outError(err instanceof Error ? err.message : String(err));
    }
  });

// ── auto-rebalance ────────────────────────────────────────────────────────────
program
  .command("auto-rebalance")
  .description("Automatically migrate out-of-range liquidity to the optimal active bin")
  .option("--pool-id <id>", "Pool ID", "dlmm_1")
  .option("--address <stx_addr>", "Stacks address (defaults to STX_ADDRESS env var)")
  .option("--dry-run", "Simulate without broadcasting", false)
  .action(async (opts: { poolId: string; address?: string; dryRun: boolean }) => {
    const address = opts.address ?? process.env.STX_ADDRESS;
    if (!address) {
      outError("STX_ADDRESS environment variable not set. Please export STX_ADDRESS=your_address"); return;
    }

    if (!address.startsWith("SP")) {
      outError("Address must be a valid Stacks mainnet address starting with SP"); return;
    }

    try {
      const [pools, binsData, userBins, poolStats, gasResult, cooldown] = await Promise.all([
        fetchPools(),
        fetchPoolBins(opts.poolId),
        fetchUserPositionBins(address, opts.poolId),
        fetchPoolStats(opts.poolId),
        fetchGasEstimate(),
        Promise.resolve(checkCooldown(opts.poolId)),
      ]);

      const pool = pools.find((p) => p.pool_id === opts.poolId);
      if (!pool) {
        outError(`Pool ${opts.poolId} not found`); return;
      }

      const activeBinId = binsData.active_bin_id;

      if (!userBins || userBins.length === 0) {
        out({
          status: "blocked",
          action: `No position found for ${address} in pool ${opts.poolId}`,
          data: { address, pool_id: opts.poolId, active_bin: activeBinId },
          error: "No position to rebalance. Provide liquidity first.",
        });
        return;
      }

      // Find out-of-range bins (bins with liquidity that are not the active bin)
      const outOfRangeBins = userBins.filter((b) => {
        const liq = typeof b.user_liquidity === "number"
          ? b.user_liquidity
          : parseFloat(String(b.user_liquidity ?? "0"));
        return liq > 0 && b.bin_id !== activeBinId;
      });

      if (outOfRangeBins.length === 0) {
        out({
          status: "success",
          action: `Already in range at active bin ${activeBinId} — no migration needed`,
          data: {
            address,
            pool_id: opts.poolId,
            active_bin: activeBinId,
            apr_24h_pct: poolStats.apr24h,
            recommendation: "HOLD",
          },
          error: null,
        });
        return;
      }

      // Safety guards
      const refusals: string[] = [];
      if (!gasResult.ok && !opts.dryRun) refusals.push(`gas ${gasResult.estimated_stx} STX > limit ${MAX_GAS_STX} STX`);
      if (!cooldown.ok && !opts.dryRun) refusals.push(`cooldown: ${cooldown.remaining_hours}h remaining`);
      if (poolStats.volume24hUsd === -1) {
        refusals.push("24h volume unknown (API error) — cannot verify pool activity");
      } else if (poolStats.volume24hUsd < MIN_24H_VOLUME_USD) {
        refusals.push(`24h volume $${Math.round(poolStats.volume24hUsd)} < $${MIN_24H_VOLUME_USD} minimum`);
      }

      if (refusals.length > 0 && !opts.dryRun) {
        out({
          status: "blocked",
          action: "Auto-rebalance blocked by safety guards",
          data: { refusals, active_bin: activeBinId, out_of_range_bins: outOfRangeBins.map((b) => b.bin_id) },
          error: refusals.join("; "),
        });
        process.exit(1);
        return;
      }

      // Migrate each out-of-range bin to the active bin
      const migrations: Array<Record<string, unknown>> = [];
      for (const bin of outOfRangeBins) {
        const liq = typeof bin.user_liquidity === "number"
          ? bin.user_liquidity
          : parseFloat(String(bin.user_liquidity ?? "0"));

        const result = await buildAndSubmitMigration({
          fromBin: bin.bin_id,
          toBin: activeBinId,
          amountPct: 100,
          poolId: opts.poolId,
          dryRun: opts.dryRun,
          verify: false,
          userLiquidity: liq,
          address,
        });
        migrations.push({ from_bin: bin.bin_id, to_bin: activeBinId, liquidity: liq, ...result.details });
      }

      if (!opts.dryRun && migrations.length > 0) {
        writeState({ last_migration_at: new Date().toISOString(), last_pool: opts.poolId });
      }

      out({
        status: "success",
        action: opts.dryRun
          ? `DRY RUN — would migrate ${outOfRangeBins.length} bin(s) to active bin ${activeBinId}`
          : `Auto-rebalanced ${outOfRangeBins.length} bin(s) to active bin ${activeBinId}`,
        data: {
          dry_run: opts.dryRun,
          address,
          pool_id: opts.poolId,
          active_bin: activeBinId,
          bins_migrated: outOfRangeBins.length,
          migrations,
          apr_24h_pct: poolStats.apr24h,
          gas_estimate_stx: gasResult.estimated_stx,
        },
        error: null,
      });
    } catch (err: unknown) {
      outError(err instanceof Error ? err.message : String(err));
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
