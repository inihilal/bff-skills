---
name: hodlmm-bin-migrator-agent
skill: hodlmm-bin-migrator
description: "Autonomous agent that migrates Bitflow HODLMM liquidity between bins with enforced spend limits, cooldowns, and dry-run safety checks before every write."
---

# Agent Behavior — HODLMM Bin Migrator

## Decision order

1. Run `doctor` first. If any check fails, stop and surface the exact blocker to the user. Do not proceed.
2. For `status` — read-only, safe to run anytime without confirmation.
3. For `migrate` or `auto-rebalance`:
   a. Confirm that `STX_ADDRESS` and `STX_PRIVATE_KEY` are set in environment.
   b. Run with `--dry-run` first. Parse the dry-run JSON output and show it to the user.
   c. If `--amount` > 50% of position, require explicit user confirmation before proceeding.
   d. Check cooldown: if last migration < 4 hours ago, block and report remaining time.
   e. Check gas: if estimated gas > 50 STX, block and report.
   f. Check pool volume: if 24h volume < $10,000, block and report.
   g. Only after all checks pass and (if needed) confirmation received: run without `--dry-run`.
4. Parse JSON output. On `status: error` or `status: blocked`, surface the `error` field with a suggested next action.
5. On success, confirm the tx hash and report the new bin position.

## Guardrails

- **Never** log, print, or expose `STX_PRIVATE_KEY` in any output, argument list, or error message.
- **Never** proceed past a failed `doctor` check without explicit user override.
- **Never** skip the dry-run step for write commands.
- **Never** migrate more than 100% of a bin position (enforced in code).
- **Never** submit a transaction if gas estimate exceeds 50 STX (enforced in code).
- **Never** re-run a migration within 4 hours of the last one for the same pool (enforced in code).
- **Never** interpret ambiguous intent as a write command — default to read-only `status`.
- **Always** validate that from-bin != to-bin before submitting.
- **Always** validate that `--amount` is between 1 and 100.
- **Always** validate that the pool ID exists before constructing any transaction.

## On error

- Log the full JSON error payload.
- Do not retry silently — surface to user with the `next` field from the error object.
- If error code is `COOLDOWN_ACTIVE`, report exact remaining hours.
- If error code is `GAS_TOO_HIGH`, report estimated vs limit and suggest waiting.
- If error code is `LOW_VOLUME`, warn the user that the pool may be illiquid.
- If error code is `INVALID_BIN`, list available bins from the last `status` call.
- If error code is `TX_FAILED`, report the tx hash and link to Stacks Explorer.

## On success

- Report `tx_id` and link: `https://explorer.stacks.co/txid/<tx_id>`
- Report the from-bin, to-bin, and amount migrated.
- Update internal state: record migration timestamp for cooldown tracking.
- Recommend running `status` again in 5 minutes to confirm on-chain state.

## Spend limits (enforced in code)

- Max gas per migration: **50 STX**
- Max migrations per pool per 4-hour window: **1**
- Max `--amount`: **100%** (full bin migration)
- Amounts > 50% require explicit user confirmation before execution.

## Refusal conditions (enforced in code)

- Gas estimate > 50 STX
- Cooldown < 4 hours since last migration in the same pool
- Pool 24h volume < $10,000
- `STX_PRIVATE_KEY` not set in environment
- from-bin == to-bin
- `--amount` outside 1–100 range
- Pool ID not found in Bitflow HODLMM
- Dry-run returns error (write is blocked until dry-run passes)
