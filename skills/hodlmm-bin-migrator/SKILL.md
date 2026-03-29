---
name: hodlmm-bin-migrator
description: "Migrates liquidity between Bitflow HODLMM bins autonomously, with safety guards, spend limits, and auto-rebalance to the optimal active bin."
metadata:
  author: "ahmadzille"
  author-agent: "Kael (AIBTC Agent)"
  user-invocable: "false"
  arguments: "doctor | status | migrate | auto-rebalance"
  entry: "hodlmm-bin-migrator/hodlmm-bin-migrator.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Bin Migrator

## What it does

Enables autonomous agents to move liquidity between bins in the Bitflow HODLMM
(Harnessed On-chain Dynamic Liquidity Market Maker). Given a from-bin, to-bin,
and percentage of liquidity to move, it constructs, signs, and broadcasts the
Stacks contract call — or in auto-rebalance mode, computes the optimal target
bin from live on-chain data and migrates automatically.

## Why agents need it

HODLMM LPs earn fees only while their liquidity sits in the active bin. When
prices shift, positions drift out of range and stop earning. Without an
autonomous migration primitive agents cannot keep positions productive; they
can only monitor (see hodlmm-bin-guardian). This skill is the *write* companion
that actually moves funds back into range.

## Safety notes

- **Writes to chain.** Every `migrate` and `auto-rebalance` command submits a
  Stacks mainnet transaction. This is irreversible once broadcast.
- **Moves funds.** Liquidity removed from one bin is re-deposited in another.
  Impermanent loss rules still apply.
- **Mainnet only.** HODLMM is not deployed on testnet.
- **Spend limits enforced in code:** max 50 STX gas per migration; refusal if
  gas > limit.
- **Cooldown enforced in code:** 4-hour minimum between migrations per pool to
  prevent thrashing.
- **Requires explicit confirmation** for amounts > 50 % of position.
- **Dry-run mode available** via `--dry-run` flag — simulates without signing.

## Commands

### doctor
Checks environment readiness: env vars, wallet address, Hiro API, Bitflow HODLMM API.
```bash
bun run skills/hodlmm-bin-migrator/hodlmm-bin-migrator.ts doctor
```

### status
Read-only. Shows active bin positions for an address across all HODLMM pools.
```bash
bun run skills/hodlmm-bin-migrator/hodlmm-bin-migrator.ts status --address SP...
```

### migrate
Moves `<pct>`% of liquidity from one bin to another. Requires wallet env vars.
```bash
bun run skills/hodlmm-bin-migrator/hodlmm-bin-migrator.ts migrate \
  --from-bin 8388607 --to-bin 8388610 --amount 100 --pool-id dlmm_1
```
Add `--dry-run` to simulate without broadcasting.

### auto-rebalance
Fetches live active bin, computes optimal target, and migrates all out-of-range
liquidity in one call.
```bash
bun run skills/hodlmm-bin-migrator/hodlmm-bin-migrator.ts auto-rebalance \
  --pool-id dlmm_1
```

## Output contract

All outputs are strict JSON to stdout.

**Success:**
```json
{ "status": "success", "action": "...", "data": {}, "error": null }
```

**Error:**
```json
{ "error": "descriptive message" }
```

**BFF extension (richer routing):**
```json
{ "status": "success|error|blocked", "action": "...", "data": {}, "error": null }
```

## Known constraints

- Requires `STX_ADDRESS` and `STX_PRIVATE_KEY` env vars for write commands.
- `STX_PRIVATE_KEY` is **never** logged or included in output.
- Will refuse to migrate if 4-hour cooldown has not elapsed.
- Will refuse if estimated gas > 50 STX.
- Will refuse if 24h pool volume < $10,000.
- `--amount` must be 1–100 (percent of bin liquidity).
- Pool must exist in Bitflow HODLMM; unknown pool IDs are rejected.
- Network: Stacks mainnet only.
