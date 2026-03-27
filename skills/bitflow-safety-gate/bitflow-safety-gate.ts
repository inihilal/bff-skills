#!/usr/bin/env bun

type Status = 'success' | 'error' | 'blocked';

type Output = {
  status: Status;
  action: string;
  data: Record<string, unknown>;
  error: null | { code: string; message: string; next: string };
};

type QuoteContext = {
  dex?: string;
  pair?: string;
  amountIn?: number;
  expectedOut?: number;
  minOut?: number;
  priceImpactBps?: number;
  slippageBps?: number;
  routeHops?: number;
  tokenIn?: string;
  tokenOut?: string;
};

function out(payload: Output) {
  console.log(JSON.stringify(payload, null, 2));
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function parseJsonArg(name: string): any | null {
  const raw = argValue(name);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function safeFetchJson(url: string) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'bitflow-safety-gate/0.4' } });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (error) {
    return { ok: false, status: 0, text: String(error), json: null };
  }
}

function getContext() {
  const btcAddress = argValue('--btc') || process.env.BTC_ADDRESS || null;
  const stxAddress = argValue('--stx') || process.env.STX_ADDRESS || null;
  const routeContext = parseJsonArg('--route-json') || null;
  const quoteContext = (parseJsonArg('--quote-json') || null) as QuoteContext | null;
  return { btcAddress, stxAddress, routeContext, quoteContext };
}

async function getStxBalance(stxAddress: string | null) {
  if (!stxAddress) return { visible: false, microStx: null, stx: null, source: null };
  const probe = await safeFetchJson(`https://api.hiro.so/extended/v1/address/${stxAddress}/balances`);
  if (!probe.ok || !probe.json || typeof probe.json !== 'object') {
    return { visible: false, microStx: null, stx: null, source: 'hiro', error: probe.text.slice(0, 160) };
  }
  const stx = (probe.json as any).stx;
  const balance = stx?.balance ?? null;
  const micro = balance ? Number(balance) : 0;
  return { visible: true, microStx: micro, stx: micro / 1_000_000, source: 'hiro' };
}

async function getBtcBalance(btcAddress: string | null) {
  if (!btcAddress) return { visible: false, sats: null, btc: null, source: null };
  const probe = await safeFetchJson(`https://mempool.space/api/address/${btcAddress}`);
  if (!probe.ok || !probe.json || typeof probe.json !== 'object') {
    return { visible: false, sats: null, btc: null, source: 'mempool.space', error: probe.text.slice(0, 160) };
  }
  const chain = (probe.json as any).chain_stats || {};
  const mempool = (probe.json as any).mempool_stats || {};
  const funded = Number(chain.funded_txo_sum || 0) + Number(mempool.funded_txo_sum || 0);
  const spent = Number(chain.spent_txo_sum || 0) + Number(mempool.spent_txo_sum || 0);
  const sats = funded - spent;
  return { visible: true, sats, btc: sats / 100_000_000, source: 'mempool.space' };
}

async function endpointHealth() {
  const aibtcNews = await safeFetchJson('https://aibtc.news/api/leaderboard');
  const bitflowHome = await fetch('https://bitflow.finance', { headers: { 'user-agent': 'bitflow-safety-gate/0.4' } })
    .then(async r => ({ ok: r.ok, status: r.status, preview: (await r.text()).slice(0, 120) }))
    .catch(e => ({ ok: false, status: 0, preview: String(e) }));
  return { aibtcNews, bitflowHome };
}

function bitflowHomeOk(v: any) {
  return Boolean(v && v.ok);
}

function gasHeuristic(stxBalance: any) {
  const stx = Number(stxBalance?.stx || 0);
  return {
    sufficientForLightAction: stx >= 0.1,
    sufficientForComfort: stx >= 0.5
  };
}

function scoreQuote(q: QuoteContext | null) {
  if (!q) {
    return {
      present: false,
      verdict: 'missing',
      score: 0,
      reasons: ['No quote context provided']
    };
  }

  const reasons: string[] = [];
  let score = 100;
  const impact = Number(q.priceImpactBps ?? 0);
  const slippage = Number(q.slippageBps ?? 0);
  const hops = Number(q.routeHops ?? 0);
  const minOut = Number(q.minOut ?? 0);
  const expectedOut = Number(q.expectedOut ?? 0);

  if (impact >= 500) { score -= 45; reasons.push('Price impact >= 5%'); }
  else if (impact >= 200) { score -= 20; reasons.push('Price impact >= 2%'); }

  if (slippage >= 300) { score -= 20; reasons.push('Slippage setting >= 3%'); }
  else if (slippage >= 100) { score -= 10; reasons.push('Slippage setting >= 1%'); }

  if (hops >= 4) { score -= 15; reasons.push('Route uses 4 or more hops'); }
  else if (hops === 3) { score -= 8; reasons.push('Route uses 3 hops'); }

  if (expectedOut > 0 && minOut > 0) {
    const bufferBps = ((expectedOut - minOut) / expectedOut) * 10000;
    if (bufferBps >= 300) { score -= 10; reasons.push('Large execution buffer between expectedOut and minOut'); }
  }

  const verdict = score >= 80 ? 'good' : score >= 55 ? 'warn' : 'blocked';
  return { present: true, verdict, score, reasons, normalized: q };
}

async function doctor() {
  const ctx = getContext();
  const endpoints = await endpointHealth();
  const stxBalance = await getStxBalance(ctx.stxAddress);
  const btcBalance = await getBtcBalance(ctx.btcAddress);
  const gas = gasHeuristic(stxBalance as any);

  const walletPresent = Boolean(ctx.btcAddress || ctx.stxAddress);
  const rpcReachable = endpoints.aibtcNews.ok;
  const apiReachable = bitflowHomeOk(endpoints.bitflowHome);
  const balancesVisible = Boolean((stxBalance as any).visible || (btcBalance as any).visible);
  const blocked = !walletPresent || !rpcReachable || !apiReachable;
  const verdict = blocked ? 'blocked' : gas.sufficientForLightAction ? 'warn' : 'blocked';

  out({
    status: blocked ? 'blocked' : 'success',
    action: blocked
      ? 'Configure wallet addresses and confirm endpoint reachability before relying on this gate.'
      : gas.sufficientForLightAction
        ? 'Environment is minimally ready. Provide quote context to evaluate execution quality.'
        : 'Top up STX before trusting this environment for live writes.',
    data: {
      skill: 'bitflow-safety-gate',
      mode: 'doctor',
      checks: {
        walletPresent,
        rpcReachable,
        apiReachable,
        balancesVisible,
        sufficientGas: gas.sufficientForLightAction
      },
      wallet: {
        ready: walletPresent,
        btcAddress: ctx.btcAddress,
        stxAddress: ctx.stxAddress
      },
      balances: {
        btc: btcBalance,
        stx: stxBalance
      },
      probes: {
        aibtcNews: { ok: endpoints.aibtcNews.ok, status: endpoints.aibtcNews.status },
        bitflow: { ok: bitflowHomeOk(endpoints.bitflowHome), status: (endpoints.bitflowHome as any).status }
      },
      verdict
    },
    error: blocked
      ? {
          code: 'ENV_NOT_READY',
          message: 'One or more readiness checks failed or wallet addresses are not configured.',
          next: 'Provide --btc / --stx (or env vars) and ensure public endpoints are reachable, then rerun doctor.'
        }
      : null
  });
}

async function installPacks() {
  out({
    status: 'success',
    action: 'No optional packs are required for scaffold v1.',
    data: {
      skill: 'bitflow-safety-gate',
      mode: 'install-packs',
      installed: [],
      pack: argValue('--pack')
    },
    error: null
  });
}

async function run() {
  const ctx = getContext();
  const endpoints = await endpointHealth();
  const stxBalance = await getStxBalance(ctx.stxAddress);
  const btcBalance = await getBtcBalance(ctx.btcAddress);
  const gas = gasHeuristic(stxBalance as any);
  const quote = scoreQuote(ctx.quoteContext);
  const hardBlocked = !ctx.btcAddress || !ctx.stxAddress || !endpoints.aibtcNews.ok || !bitflowHomeOk(endpoints.bitflowHome);
  const noGas = !gas.sufficientForLightAction;

  let verdict: 'go' | 'warn' | 'blocked' = 'blocked';
  if (!hardBlocked) {
    if (quote.verdict === 'good' && gas.sufficientForComfort) verdict = 'go';
    else if (quote.present && quote.verdict !== 'blocked') verdict = 'warn';
    else verdict = 'blocked';
    if (noGas && verdict === 'go') verdict = 'warn';
  }

  out({
    status: hardBlocked ? 'blocked' : 'success',
    action: hardBlocked
      ? 'Do not execute. Fix wallet/environment readiness first.'
      : !quote.present
        ? 'Provide quote context before asking for an execution verdict.'
        : verdict === 'go'
          ? 'Conditions look acceptable, but manual review is still recommended for mainnet execution.'
          : verdict === 'warn'
            ? 'Execution may proceed only with caution; review route impact and buffers manually.'
            : 'Do not execute under current route/context conditions.',
    data: {
      skill: 'bitflow-safety-gate',
      mode: 'run',
      verdict,
      wallet: {
        ready: Boolean(ctx.btcAddress && ctx.stxAddress),
        btcAddress: ctx.btcAddress,
        stxAddress: ctx.stxAddress
      },
      balances: {
        btc: btcBalance,
        stx: stxBalance
      },
      environment: {
        rpcReachable: endpoints.aibtcNews.ok,
        apiReachable: bitflowHomeOk(endpoints.bitflowHome)
      },
      execution: {
        sufficientGas: gas.sufficientForLightAction,
        gasComfort: gas.sufficientForComfort,
        routeSanity: quote.verdict,
        quoteScore: quote.score,
        quoteReasons: quote.reasons,
        liquidityContext: quote.present ? 'quote-present' : 'unknown'
      },
      quote: quote.present ? quote.normalized : null,
      routeContext: ctx.routeContext
    },
    error: hardBlocked
      ? {
          code: 'EXECUTION_NOT_READY',
          message: 'Wallet or endpoint prerequisites are not ready for a safe execution verdict.',
          next: 'Restore readiness and rerun doctor/run.'
        }
      : !quote.present
        ? {
            code: 'MISSING_QUOTE_CONTEXT',
            message: 'No quote context was provided to evaluate.',
            next: 'Provide --quote-json with expectedOut, minOut, priceImpactBps, slippageBps, and routeHops.'
          }
        : null
  });
}

const cmd = process.argv[2];
if (cmd === 'doctor') await doctor();
else if (cmd === 'run') await run();
else if (cmd === 'install-packs') await installPacks();
else {
  out({
    status: 'error',
    action: 'Use `doctor`, `run`, or `install-packs`.',
    data: { received: cmd ?? null },
    error: {
      code: 'INVALID_COMMAND',
      message: 'Unknown command.',
      next: 'Invoke with `doctor`, `run`, or `install-packs`.'
    }
  });
}
