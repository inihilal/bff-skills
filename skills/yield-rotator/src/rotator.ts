/**
 * rotator.ts -- Core yield rotation logic
 *
 * Decision flow:
 *  1. Fetch APY from Hermetica (sUSDh staking)
 *  2. Fetch APR from HODLMM (LP fees)
 *  3. Compute gap = |hermetica_apy - hodlmm_apr|
 *  4. If gap >= threshold AND better protocol differs from current allocation:
 *       -> Execute rotation
 *  5. Apply safety guards before executing
 */

import {
  fetchHermeticaRatio,
  computeApyFromRatios,
  isStakingEnabled,
  getCooldownWindowSeconds,
  getHermeticaPosition,
  stakeUsdh,
  unstakeSUsdh,
  type HermeticaAPY,
} from "./hermetica.js";
import {
  fetchHodlmmAPR,
  getHodlmmPosition,
  addLiquidity,
  removeLiquidity,
  type HodlmmAPR,
} from "./hodlmm.js";
import {
  DEFAULT_GAP_THRESHOLD_PCT,
  MIN_ROTATE_AMOUNT_USDH,
  MAX_SLIPPAGE_PCT,
  type NetworkType,
  DEFAULT_HODLMM_POOL_ID,
} from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Protocol = "hermetica" | "hodlmm" | "none";

export interface YieldSnapshot {
  hermeticaApyPct: number;
  hodlmmAprPct: number;
  gapPct: number;
  betterProtocol: Protocol;
  timestamp: string;
}

export interface RotationDecision {
  shouldRotate: boolean;
  from: Protocol;
  to: Protocol;
  reason: string;
  snapshot: YieldSnapshot;
}

export interface RotationResult {
  decision: RotationDecision;
  executed: boolean;
  dryRun: boolean;
  txids: string[];
  errors: string[];
}

// In-memory cache for ratio snapshots
let _ratioCache: HermeticaAPY | null = null;

// Suppress unused import warning
const _unusedHodlmmAPR: typeof HodlmmAPR | undefined = undefined;
void _unusedHodlmmAPR;

// ---------------------------------------------------------------------------
// Yield Monitor
// ---------------------------------------------------------------------------

export async function fetchYieldSnapshot(
  network: NetworkType = "mainnet",
  hodlmmPoolId = DEFAULT_HODLMM_POOL_ID
): Promise<YieldSnapshot> {
  console.log("[Rotator] Fetching yield data from both protocols...");

  const [currentRatio, hodlmmApr] = await Promise.all([
    fetchHermeticaRatio(network),
    fetchHodlmmAPR(hodlmmPoolId, network),
  ]);

  let hermeticaApyPct = 0;
  if (_ratioCache) {
    const hoursDiff =
      (new Date(currentRatio.sampledAt).getTime() -
        new Date(_ratioCache.sampledAt).getTime()) /
      (1000 * 60 * 60);
    if (hoursDiff >= 1) {
      try {
        hermeticaApyPct = computeApyFromRatios(_ratioCache, currentRatio);
        console.log(`[Rotator] Hermetica APY (from ${hoursDiff.toFixed(1)}h samples): ${hermeticaApyPct.toFixed(2)}%`);
      } catch (e) {
        console.warn(`[Rotator] Could not compute APY from samples: ${(e as Error).message}`);
      }
    } else {
      console.log("[Rotator] Ratio samples too close together -- APY estimate pending.");
    }
  } else {
    if (currentRatio.ratio > 1.0) {
      const HERMETICA_LAUNCH = new Date("2025-01-06T00:00:00Z").getTime();
      const daysSinceLaunch =
        (new Date(currentRatio.sampledAt).getTime() - HERMETICA_LAUNCH) /
        (1000 * 60 * 60 * 24);
      if (daysSinceLaunch > 1) {
        const cumulativeYield = currentRatio.ratio - 1.0;
        hermeticaApyPct =
          (Math.pow(1 + cumulativeYield, 365 / daysSinceLaunch) - 1) * 100;
        console.log(
          `[Rotator] Hermetica APY (cumulative: ratio=${currentRatio.ratio.toFixed(6)}, ` +
          `${daysSinceLaunch.toFixed(0)}d since launch): ${hermeticaApyPct.toFixed(2)}%`
        );
      }
    } else {
      console.log("[Rotator] First sample stored. Cumulative APY unavailable (ratio <= 1.0).");
    }
  }

  _ratioCache = currentRatio;

  const hodlmmAprPct = hodlmmApr.aprPct;
  const gapPct = Math.abs(hermeticaApyPct - hodlmmAprPct);
  const betterProtocol: Protocol =
    hermeticaApyPct === 0 && hodlmmAprPct === 0
      ? "none"
      : hermeticaApyPct >= hodlmmAprPct
      ? "hermetica"
      : "hodlmm";

  console.log(
    `[Rotator] Hermetica APY: ${hermeticaApyPct.toFixed(2)}% | ` +
    `HODLMM APR: ${hodlmmAprPct.toFixed(2)}% | ` +
    `Gap: ${gapPct.toFixed(2)}% | ` +
    `Better: ${betterProtocol}`
  );

  return {
    hermeticaApyPct,
    hodlmmAprPct,
    gapPct,
    betterProtocol,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Decision Engine
// ---------------------------------------------------------------------------

export function makeRotationDecision(
  snapshot: YieldSnapshot,
  currentProtocol: Protocol,
  gapThresholdPct = DEFAULT_GAP_THRESHOLD_PCT
): RotationDecision {
  const { gapPct, betterProtocol } = snapshot;

  if (betterProtocol === "none") {
    return {
      shouldRotate: false,
      from: currentProtocol,
      to: "none",
      reason: "Yield data unavailable -- skipping rotation.",
      snapshot,
    };
  }

  if (currentProtocol === betterProtocol) {
    return {
      shouldRotate: false,
      from: currentProtocol,
      to: betterProtocol,
      reason: `Already in best protocol (${betterProtocol}). Gap=${gapPct.toFixed(2)}%.`,
      snapshot,
    };
  }

  if (gapPct < gapThresholdPct) {
    return {
      shouldRotate: false,
      from: currentProtocol,
      to: betterProtocol,
      reason: `Gap ${gapPct.toFixed(2)}% < threshold ${gapThresholdPct}%. Not worth rotating.`,
      snapshot,
    };
  }

  if (currentProtocol === "none") {
    return {
      shouldRotate: true,
      from: "none",
      to: betterProtocol,
      reason: `No current position. Gap=${gapPct.toFixed(2)}% >= ${gapThresholdPct}%. Deploy to ${betterProtocol}.`,
      snapshot,
    };
  }

  return {
    shouldRotate: true,
    from: currentProtocol,
    to: betterProtocol,
    reason:
      `Gap ${gapPct.toFixed(2)}% >= threshold ${gapThresholdPct}%. ` +
      `Rotating from ${currentProtocol} -> ${betterProtocol}.`,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Safety Guards
// ---------------------------------------------------------------------------

export interface SafetyCheckResult {
  passed: boolean;
  warnings: string[];
  blockers: string[];
}

export async function runSafetyChecks(
  decision: RotationDecision,
  network: NetworkType = "mainnet"
): Promise<SafetyCheckResult> {
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (decision.to === "hermetica") {
    const enabled = await isStakingEnabled(network);
    if (!enabled) {
      blockers.push("Hermetica staking is currently disabled by the protocol.");
    }
  }

  if (decision.from === "hermetica") {
    const cooldownSecs = await getCooldownWindowSeconds(network);
    const cooldownDays = cooldownSecs / 86400;
    warnings.push(
      `Unstaking from Hermetica initiates a ${cooldownDays.toFixed(1)}-day cooldown.`
    );
  }

  if (decision.to === "hermetica" || decision.to === "hodlmm") {
    const position = await getHermeticaPosition(network);
    if (
      decision.from === "hermetica" &&
      position.usdhEquivalent < MIN_ROTATE_AMOUNT_USDH
    ) {
      blockers.push(
        `Position too small to rotate: ${position.usdhEquivalent.toFixed(2)} USDh < minimum ${MIN_ROTATE_AMOUNT_USDH} USDh.`
      );
    }
  }

  const estimatedSlippage = 0.1;
  if (estimatedSlippage > MAX_SLIPPAGE_PCT) {
    blockers.push(`Estimated slippage ${estimatedSlippage}% exceeds max allowed ${MAX_SLIPPAGE_PCT}%.`);
  }

  if (!process.env.STACKS_PRIVATE_KEY) {
    blockers.push("STACKS_PRIVATE_KEY not set -- cannot sign transactions.");
  }

  return {
    passed: blockers.length === 0,
    warnings,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function executeRotation(
  decision: RotationDecision,
  amountUsdh: number,
  dryRun = false,
  network: NetworkType = "mainnet",
  hodlmmPoolId = DEFAULT_HODLMM_POOL_ID
): Promise<RotationResult> {
  const txids: string[] = [];
  const errors: string[] = [];

  if (!decision.shouldRotate) {
    console.log(`[Rotator] No rotation needed: ${decision.reason}`);
    return { decision, executed: false, dryRun, txids, errors };
  }

  console.log(`[Rotator] ${dryRun ? "[DRY-RUN] " : ""}Executing rotation: ${decision.reason}`);

  const safety = await runSafetyChecks(decision, network);
  for (const w of safety.warnings) console.warn(`[Rotator] WARNING: ${w}`);
  if (!safety.passed) {
    for (const b of safety.blockers) {
      console.error(`[Rotator] BLOCKED: ${b}`);
      errors.push(b);
    }
    return { decision, executed: false, dryRun, txids, errors };
  }

  try {
    if (decision.from === "hermetica") {
      const pos = await getHermeticaPosition(network);
      if (pos.sUsdhBalance > 0) {
        const unstakeRes = await unstakeSUsdh(pos.sUsdhBalance, dryRun, network);
        txids.push(unstakeRes.txid);
      }
    } else if (decision.from === "hodlmm") {
      const pos = await getHodlmmPosition(hodlmmPoolId, undefined, network);
      if (pos.lpTokenBalance > 0) {
        const removeRes = await removeLiquidity(hodlmmPoolId, pos.lpTokenBalance, dryRun, network);
        txids.push(removeRes.txid);
      }
    }

    if (decision.to === "hermetica") {
      const stakeRes = await stakeUsdh(amountUsdh, dryRun, network);
      txids.push(stakeRes.txid);
    } else if (decision.to === "hodlmm") {
      const half = amountUsdh / 2;
      const addRes = await addLiquidity(hodlmmPoolId, half, half, dryRun, network);
      txids.push(addRes.txid);
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[Rotator] Execution error: ${msg}`);
    errors.push(msg);
    return { decision, executed: false, dryRun, txids, errors };
  }

  console.log(`[Rotator] Rotation complete. TxIDs: ${txids.join(", ")}`);
  return { decision, executed: true, dryRun, txids, errors };
}
