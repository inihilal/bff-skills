# Bitflow Safety Gate

## One-line pitch
Bitflow Safety Gate stops autonomous agents from executing weak, unsafe, or poorly conditioned DeFi actions by returning a disciplined **GO / WARN / BLOCK** verdict before execution.

## Why this should exist
Most DeFi agent tools answer one of these questions:
- Is this token risky?
- Is this protocol risky?
- What route looks best?

Those are useful, but they still leave a dangerous gap:

> **Should the agent execute this action right now?**

Bitflow Safety Gate is designed to fill that gap.

It is not a hype engine, not a token shill tool, and not an auto-trader. It is a conservative execution gate for agentic DeFi.

## What it checks
In its current v1 form, the skill evaluates:
- wallet presence and address detection
- visible BTC / STX balances
- AIBTC News and Bitflow endpoint reachability
- quote sanity from structured quote context
- execution blockers before a write

## Bitflow-native angle
This skill is no longer only a generic readiness checker.
It now accepts **quote context** that resembles a Bitflow-style execution decision and scores:
- price impact
- slippage tolerance
- route hop count
- expectedOut vs minOut execution buffer

That lets it answer a more commercially useful question:

> **Is this route/execution context good enough for an agent to proceed?**

## Core output
Instead of vague risk scores, the skill returns a structured verdict:
- **GO** — execution conditions are acceptable
- **WARN** — proceed only with caution / degraded context
- **BLOCK** — do not execute

## Why it is commercially interesting
This skill is aimed at a real pain point in agentic DeFi:

> agents should not execute dumb moves just because they *can*.

That gives it a stronger commercial shape than a generic readiness checker.

It can be sold as:
- a pre-trade execution gate
- a route sanity filter
- a final safety layer before autonomous action
- a reusable risk-control primitive for other agents

## Differentiation
Bitflow Safety Gate is **not** trying to beat full security scanners or token scoring platforms at their own game.
Its position is narrower and more useful:
- not “is this project good?”
- not “what is the best route in theory?”
- but:
- **“Should this agent execute this action now, under these conditions?”**

## Current commands
```bash
bun run bitflow-safety-gate/bitflow-safety-gate.ts doctor --btc <btc> --stx <stx>
bun run bitflow-safety-gate/bitflow-safety-gate.ts install-packs --pack all
bun run bitflow-safety-gate/bitflow-safety-gate.ts run --btc <btc> --stx <stx> --quote-json '{...}'
```

## Example quote context
```json
{
  "dex": "bitflow",
  "pair": "STX/sBTC",
  "amountIn": 1000,
  "expectedOut": 985,
  "minOut": 970,
  "priceImpactBps": 120,
  "slippageBps": 100,
  "routeHops": 2,
  "tokenIn": "STX",
  "tokenOut": "sBTC"
}
```

## Example operator value
If a quote comes in with:
- high price impact
- wide slippage
- too many route hops
- poor output buffer

then the skill can downgrade the action from a naïve execution candidate into `warn` or `blocked` before funds move.

## Current limitations
- quote scoring is heuristic, not protocol-native quoting
- no on-chain proof path yet
- no direct Bitflow quote API integration yet
- no live trade execution path

## Next milestone
The next milestone is direct Bitflow quote/API integration plus stronger proof that the gate catches bad execution conditions on real routes.
