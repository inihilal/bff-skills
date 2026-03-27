---
name: bitflow-safety-gate
description: Prevent autonomous agents from executing weak, unsafe, or poorly conditioned DeFi actions by evaluating route sanity, liquidity context, execution prerequisites, and environment readiness before trade execution. Use when an agent is about to route, swap, LP, or otherwise act on Bitflow/Stacks DeFi.
author: zille
author_agent: Lasting Vera
user-invocable: true
arguments: doctor | run | install-packs
entry: bitflow-safety-gate/bitflow-safety-gate.ts
requires: [wallet, signing, settings]
tags: [infrastructure, defi, mainnet-only, sensitive, l2]
---

# Bitflow Safety Gate

## What it does
Evaluates whether a proposed Bitflow/Stacks DeFi action should proceed. Instead of merely scoring a token or protocol, this skill acts as an **execution gate** for autonomous agents, returning `go`, `warn`, or `blocked` before a trade or route is attempted.

## Core promise
This skill helps prevent agents from executing dumb DeFi moves.

## What it checks
- Wallet-related environment presence (when configured)
- Spendable balance visibility (when configured)
- Environment readiness (RPC/API reachability)
- Route / quote sanity inputs (when available)
- Liquidity / execution context inputs (when available)
- Obvious blocker conditions before a write

## Why it is different
Most tools answer: “Is this token/protocol risky?”
This skill answers: **“Should this agent execute this action right now?”**

## Safety notes
- `doctor` is read-only.
- `run` in v1 remains a conservative preflight verdict generator, not an executor.
- If data is incomplete, the skill should prefer `blocked` or `warn` over false confidence.
- This is for real-funds environments; conservative behavior is required.

## Commands

### doctor
Checks whether the environment is capable of supporting a safe Bitflow-style DeFi decision.
```bash
bun run bitflow-safety-gate/bitflow-safety-gate.ts doctor
```

### run
Evaluates a candidate action and returns a JSON verdict.
```bash
bun run bitflow-safety-gate/bitflow-safety-gate.ts run
```

### install-packs
Installs optional dependency packs or returns a no-op result when no extra packs are needed.
```bash
bun run bitflow-safety-gate/bitflow-safety-gate.ts install-packs --pack all
```

## Output contract
```json
{
  "status": "success | error | blocked",
  "action": "recommended next step",
  "data": {
    "verdict": "go | warn | blocked",
    "wallet": {
      "ready": true,
      "btcAddress": "bc1...",
      "stxAddress": "SP..."
    },
    "environment": {
      "rpcReachable": true,
      "apiReachable": true
    },
    "execution": {
      "sufficientGas": false,
      "routeSanity": "unknown",
      "liquidityContext": "unknown"
    }
  },
  "error": null
}
```

## Known constraints
- Requires configured wallet inputs to produce a full execution verdict.
- In v1, route and liquidity checks are still conservative and partial.
- A healthy result does not imply profitability; it only reduces obvious bad execution conditions.
- No on-chain proof path yet.
