#!/usr/bin/env node
/**
 * yield-rotator.ts — CLI entry point
 *
 * Commands:
 *   monitor    Fetch current APY/APR from both protocols and display gap
 *   rotate     Evaluate and execute a yield rotation (if gap >= threshold)
 *   stake      Directly stake USDh into Hermetica
 *   unstake    Directly unstake sUSDh from Hermetica
 *   position   Show current positions on both protocols
 *
 * Global flags:
 *   --network <mainnet|testnet>   Target Stacks network (default: mainnet)
 *   --dry-run                     Simulate without broadcasting transactions
 *   --gap-threshold <pct>         Min gap % to trigger rotation (default: 2.0)
 *   --pool <id>                   HODLMM pool ID (default: STX-USDh)
 */

import { Command } from "commander";
import * as dotenv from "dotenv";
dotenv.config();

import { fetchYieldSnapshot, makeRotationDecision, executeRotation, type Protocol } from "./src/rotator.js";
import { stakeUsdh, unstakeSUsdh, getHermeticaPosition } from "./src/hermetica.js";
import { getHodlmmPosition } from "./src/hodlmm.js";
import { DEFAULT_GAP_THRESHOLD_PCT, DEFAULT_HODLMM_POOL_ID, type NetworkType } from "./src/config.js";

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("yield-rotator")
  .description("Cross-protocol yield optimizer: Hermetica sUSDh <-> HODLMM LP")
  .version("0.1.0");

// Shared options added to each subcommand
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option(
      "--network <network>",
      "Stacks network: mainnet or testnet",
      "mainnet"
    )
    .option("--dry-run", "Simulate without broadcasting transactions", false)
    .option(
      "--gap-threshold <pct>",
      "Minimum yield gap % to trigger rotation",
      String(DEFAULT_GAP_THRESHOLD_PCT)
    )
    .option("--pool <id>", "HODLMM pool ID (default: dlmm_1 = STX/USDh)", DEFAULT_HODLMM_POOL_ID);
}

// ---------------------------------------------------------------------------
// monitor command
// ---------------------------------------------------------------------------

addCommonOptions(
  program
    .command("monitor")
    .description("Fetch current APY/APR from both protocols and display yield gap")
).action(async (opts) => {
  const network = opts.network as NetworkType;
  const pool = opts.pool as string;

  console.log(`\n=== Yield Monitor === [${network}] [${new Date().toISOString()}]`);

  try {
    const snapshot = await fetchYieldSnapshot(network, pool);

    console.log("\n--- Yield Snapshot ---");
    console.log(`  Hermetica sUSDh APY : ${snapshot.hermeticaApyPct.toFixed(2)}%`);
    console.log(`  HODLMM LP APR       : ${snapshot.hodlmmAprPct.toFixed(2)}%`);
    console.log(`  Gap                 : ${snapshot.gapPct.toFixed(2)}%`);
    console.log(`  Better protocol     : ${snapshot.betterProtocol}`);
    console.log(`  Threshold           : ${opts.gapThreshold}%`);
    console.log(
      `  Rotation signal     : ${
        snapshot.gapPct >= parseFloat(opts.gapThreshold) ? "YES -- gap exceeds threshold" : "NO -- below threshold"
      }`
    );
    console.log("----------------------\n");
  } catch (err) {
    console.error(`[monitor] Error: ${(err as Error).message}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// rotate command
// ---------------------------------------------------------------------------

addCommonOptions(
  program
    .command("rotate")
    .description("Evaluate yield gap and execute rotation if threshold is met")
    .requiredOption("--amount <usdh>", "Amount in USDh to rotate (e.g. 100)")
    .option(
      "--current <protocol>",
      "Current protocol allocation: hermetica | hodlmm | none",
      "none"
    )
).action(async (opts) => {
  const network = opts.network as NetworkType;
  const dryRun = opts.dryRun as boolean;
  const pool = opts.pool as string;
  const amount = parseFloat(opts.amount);
  const gapThreshold = parseFloat(opts.gapThreshold);
  const currentProtocol = opts.current as Protocol;

  if (isNaN(amount) || amount <= 0) {
    console.error("[rotate] --amount must be a positive number");
    process.exit(1);
  }

  console.log(
    `\n=== Yield Rotator === [${network}]${dryRun ? " [DRY-RUN]" : ""} [${new Date().toISOString()}]`
  );
  console.log(`  Amount       : ${amount} USDh`);
  console.log(`  Current      : ${currentProtocol}`);
  console.log(`  Gap threshold: ${gapThreshold}%`);

  try {
    const snapshot = await fetchYieldSnapshot(network, pool);
    const decision = makeRotationDecision(snapshot, currentProtocol, gapThreshold);

    console.log(`\n--- Decision ---`);
    console.log(`  Should rotate: ${decision.shouldRotate}`);
    console.log(`  From         : ${decision.from}`);
    console.log(`  To           : ${decision.to}`);
    console.log(`  Reason       : ${decision.reason}`);
    console.log("----------------\n");

    if (!decision.shouldRotate) {
      console.log("No rotation needed. Exiting.");
      return;
    }

    const result = await executeRotation(decision, amount, dryRun, network, pool);

    console.log("\n--- Rotation Result ---");
    console.log(`  Executed : ${result.executed}`);
    console.log(`  Dry-run  : ${result.dryRun}`);
    console.log(`  TxIDs    : ${result.txids.join(", ") || "none"}`);
    if (result.errors.length > 0) {
      console.error(`  Errors   : ${result.errors.join("; ")}`);
      process.exit(1);
    }
    console.log("-----------------------\n");
  } catch (err) {
    console.error(`[rotate] Error: ${(err as Error).message}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// stake command
// ---------------------------------------------------------------------------

addCommonOptions(
  program
    .command("stake")
    .description("Directly stake USDh into Hermetica to receive sUSDh")
    .requiredOption("--amount <usdh>", "Amount in USDh to stake")
).action(async (opts) => {
  const network = opts.network as NetworkType;
  const dryRun = opts.dryRun as boolean;
  const amount = parseFloat(opts.amount);

  if (isNaN(amount) || amount <= 0) {
    console.error("[stake] --amount must be a positive number");
    process.exit(1);
  }

  console.log(
    `\n=== Stake === [${network}]${dryRun ? " [DRY-RUN]" : ""}`
  );
  console.log(`  Staking ${amount} USDh into Hermetica...`);

  try {
    const result = await stakeUsdh(amount, dryRun, network);
    console.log(`  TxID     : ${result.txid}`);
    console.log(`  Amount   : ${amount} USDh (${result.amountUsdhMicro} micro)`);
    console.log(`  Dry-run  : ${result.dryRun}`);
  } catch (err) {
    console.error(`[stake] Error: ${(err as Error).message}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// unstake command
// ---------------------------------------------------------------------------

addCommonOptions(
  program
    .command("unstake")
    .description("Initiate unstake of sUSDh from Hermetica (7-day cooldown)")
    .requiredOption("--amount <susdh>", "Amount in sUSDh to unstake")
).action(async (opts) => {
  const network = opts.network as NetworkType;
  const dryRun = opts.dryRun as boolean;
  const amount = parseFloat(opts.amount);

  if (isNaN(amount) || amount <= 0) {
    console.error("[unstake] --amount must be a positive number");
    process.exit(1);
  }

  console.log(
    `\n=== Unstake === [${network}]${dryRun ? " [DRY-RUN]" : ""}`
  );
  console.log(`  Unstaking ${amount} sUSDh from Hermetica...`);
  console.log(`  WARNING: 7-day cooldown applies. Funds locked until cooldown expires.`);

  try {
    const result = await unstakeSUsdh(amount, dryRun, network);
    console.log(`  TxID     : ${result.txid}`);
    console.log(`  Claim-ID : ${result.claimId ?? "pending confirmation"}`);
    console.log(`  Dry-run  : ${result.dryRun}`);
  } catch (err) {
    console.error(`[unstake] Error: ${(err as Error).message}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// position command
// ---------------------------------------------------------------------------

addCommonOptions(
  program
    .command("position")
    .description("Show current positions on Hermetica and HODLMM")
    .option("--address <addr>", "Wallet address (defaults to STACKS_ADDRESS env var)")
).action(async (opts) => {
  const network = opts.network as NetworkType;
  const pool = opts.pool as string;
  const address = opts.address as string | undefined;

  console.log(`\n=== Positions === [${network}] [${new Date().toISOString()}]`);

  try {
    const [hermeticaPos, hodlmmPos] = await Promise.all([
      getHermeticaPosition(network, address),
      getHodlmmPosition(pool, address, network),
    ]);

    console.log("\n--- Hermetica ---");
    console.log(`  sUSDh balance    : ${hermeticaPos.sUsdhBalance.toFixed(6)} sUSDh`);
    console.log(`  USDh equivalent  : $${hermeticaPos.usdhEquivalent.toFixed(2)}`);

    console.log("\n--- HODLMM ---");
    console.log(`  Pool             : ${hodlmmPos.poolId}`);
    console.log(`  LP token balance : ${hodlmmPos.lpTokenBalance.toFixed(8)}`);
    console.log(`  Token A amount   : ${hodlmmPos.tokenAAmount.toFixed(6)}`);
    console.log(`  Token B amount   : ${hodlmmPos.tokenBAmount.toFixed(6)}`);
    console.log(
      `  Accrued fees     : ${
        hodlmmPos.accruedFeesUsd !== null
          ? "$" + hodlmmPos.accruedFeesUsd.toFixed(2)
          : "N/A"
      }`
    );
    console.log("------------------\n");
  } catch (err) {
    console.error(`[position] Error: ${(err as Error).message}`);
    process.exit(1);
  }
});

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
