# Yield Rotator — Cross-Protocol Yield Optimizer

**Day 5 Submission** | Category: Trading / Yield

## What It Does

Monitors Hermetica sUSDh staking APY vs Bitflow HODLMM live APR. When the yield gap hits 2%+, it rotates capital to the higher-yielding protocol.

## Commands

- `monitor` — Fetch and display APY/APR from both protocols
- `rotate` — Auto-rotate if gap >= threshold (default 2%)
- `stake <amount>` — Stake USDh to Hermetica
- `unstake <amount>` — Unstake sUSDh from Hermetica
- `position` — View positions on both protocols

## Environment Variables

- `STACKS_PRIVATE_KEY` — Stacks wallet private key
- `STACKS_ADDRESS` — Stacks wallet address
- `GAP_THRESHOLD_PCT` — Minimum yield gap to trigger rotation (default: 2.0)
- `MIN_ROTATE_AMOUNT_USDH` — Minimum amount to rotate (default: 10)
- `SLIPPAGE_PCT` — Max slippage for swaps (default: 1.0)

## Protocols

- Hermetica (sUSDh staking)
- Bitflow HODLMM (dual-sided liquidity pools)
