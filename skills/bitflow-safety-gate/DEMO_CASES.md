# Bitflow Safety Gate — Demo Cases

These are simple demo scenarios to show how the skill behaves under different execution conditions.

## Shared context
- BTC address: `bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf`
- STX address: `SPVA6PF433DM3AFHS3GEWJEFFD5223WZT0XHRSD5`
- Current observed STX balance: ~0.4906 STX
- Current observed BTC balance: 0 BTC

## Case 1 — GOOD route but still WARN due to low gas comfort
Use when route looks acceptable but operator should still proceed carefully.

```bash
bun run bitflow-safety-gate.ts run \
  --btc bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf \
  --stx SPVA6PF433DM3AFHS3GEWJEFFD5223WZT0XHRSD5 \
  --quote-json '{"dex":"bitflow","pair":"STX/sBTC","amountIn":1000,"expectedOut":985,"minOut":970,"priceImpactBps":120,"slippageBps":100,"routeHops":2,"tokenIn":"STX","tokenOut":"sBTC"}'
```

Expected outcome:
- `status: success`
- `verdict: warn`
- because route looks sane, but gas comfort is still not strong and slippage is non-trivial.

## Case 2 — WARN due to degraded route quality
Use when the route is still possible but increasingly questionable.

```bash
bun run bitflow-safety-gate.ts run \
  --btc bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf \
  --stx SPVA6PF433DM3AFHS3GEWJEFFD5223WZT0XHRSD5 \
  --quote-json '{"dex":"bitflow","pair":"STX/sBTC","amountIn":1000,"expectedOut":960,"minOut":920,"priceImpactBps":260,"slippageBps":180,"routeHops":3,"tokenIn":"STX","tokenOut":"sBTC"}'
```

Expected outcome:
- `status: success`
- `verdict: warn`
- because price impact, slippage, and route length are all worse.

## Case 3 — BLOCKED due to clearly bad route
Use when the route should not be executed.

```bash
bun run bitflow-safety-gate.ts run \
  --btc bc1q3x3mrwxa2lfy2z8w40y7yza3ht0panvk6saalf \
  --stx SPVA6PF433DM3AFHS3GEWJEFFD5223WZT0XHRSD5 \
  --quote-json '{"dex":"bitflow","pair":"STX/sBTC","amountIn":1000,"expectedOut":900,"minOut":820,"priceImpactBps":650,"slippageBps":350,"routeHops":4,"tokenIn":"STX","tokenOut":"sBTC"}'
```

Expected outcome:
- `status: success`
- `verdict: blocked`
- because route quality is too degraded for safe autonomous execution.
