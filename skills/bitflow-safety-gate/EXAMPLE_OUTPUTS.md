# Example Outputs — Bitflow Safety Gate

## doctor
Observed using Lasting Vera wallet context.

- walletPresent: true
- rpcReachable: true
- apiReachable: true
- balancesVisible: true
- BTC visible: 0 BTC
- STX visible: 0.4906 STX
- verdict: `warn`

## run — Example 1
Quote context:
- pair: STX/sBTC
- priceImpactBps: 120
- slippageBps: 100
- routeHops: 2

Output:
- verdict: `warn`
- reason: route looks sane, but still requires caution

## run — Example 2
Quote context:
- pair: STX/sBTC
- priceImpactBps: 260
- slippageBps: 180
- routeHops: 3

Output:
- verdict: `warn`
- quoteScore: 52
- reasons:
  - Price impact >= 2%
  - Slippage setting >= 1%
  - Route uses 3 hops
  - Large execution buffer between expectedOut and minOut

## run — Example 3
Quote context:
- pair: STX/sBTC
- priceImpactBps: 650
- slippageBps: 350
- routeHops: 4

Output:
- verdict: `blocked`
- quoteScore: 10
- reasons:
  - Price impact >= 5%
  - Slippage setting >= 3%
  - Route uses 4 or more hops
  - Large execution buffer between expectedOut and minOut
