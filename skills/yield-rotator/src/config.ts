import * as dotenv from "dotenv";
dotenv.config();

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
export type NetworkType = "mainnet" | "testnet";

export const DEFAULT_NETWORK: NetworkType = "mainnet";

// ---------------------------------------------------------------------------
// Hermetica contract addresses (Stacks mainnet)
// ---------------------------------------------------------------------------
export const HERMETICA_DEPLOYER =
  "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";

export const HERMETICA_CONTRACTS = {
  USDH_TOKEN: `${HERMETICA_DEPLOYER}.usdh-token-v1`,
  SUSDH_TOKEN: `${HERMETICA_DEPLOYER}.susdh-token-v1`,
  STAKING: `${HERMETICA_DEPLOYER}.staking-v1-1`,
  STAKING_STATE: `${HERMETICA_DEPLOYER}.staking-state-v1`,
  STAKING_RESERVE: `${HERMETICA_DEPLOYER}.staking-reserve-v1`,
  STAKING_SILO: `${HERMETICA_DEPLOYER}.staking-silo-v1-1`,
  HQ: `${HERMETICA_DEPLOYER}.hq-v1`,
  CONTROLLER: `${HERMETICA_DEPLOYER}.controller-v1-1`,
  REDEEMING_RESERVE: `${HERMETICA_DEPLOYER}.redeeming-reserve-v1-2`,
} as const;

// Token decimals
export const USDH_DECIMALS = 6; // 1 USDh = 1_000_000 micro
export const SUSDH_DECIMALS = 8; // 1 sUSDh = 100_000_000 micro

// ---------------------------------------------------------------------------
// HODLMM contract addresses (Stacks mainnet)
// ---------------------------------------------------------------------------
export const HODLMM_DEPLOYER = "SP2ZNGJ85ENDY6QRHQ5P2D4FXKGZWCKTB2T0Z55KS"; // placeholder

export const HODLMM_CONTRACTS = {
  CORE: `${HODLMM_DEPLOYER}.hodlmm-v1`,
  POOL: `${HODLMM_DEPLOYER}.hodlmm-pool-v1`,
} as const;

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------
export const HIRO_API_MAINNET = "https://api.hiro.so";
export const HIRO_API_TESTNET = "https://api.testnet.hiro.so";

export const getHiroApiUrl = (network: NetworkType): string =>
  network === "mainnet" ? HIRO_API_MAINNET : HIRO_API_TESTNET;

// ---------------------------------------------------------------------------
// Yield rotation thresholds
// ---------------------------------------------------------------------------
export const DEFAULT_GAP_THRESHOLD_PCT = 2.0;
export const MIN_ROTATE_AMOUNT_USDH = 10;
export const MAX_SLIPPAGE_PCT = 1.0;
export const COOLDOWN_BUFFER_BLOCKS = 10;

// ---------------------------------------------------------------------------
// Wallet / signer (from env)
// ---------------------------------------------------------------------------
export const STACKS_PRIVATE_KEY = process.env.STACKS_PRIVATE_KEY ?? "";
export const STACKS_ADDRESS = process.env.STACKS_ADDRESS ?? "";
export const HIRO_API_KEY = process.env.HIRO_API_KEY ?? "";

// ---------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------
export const DRY_RUN_DEFAULT = false;
export const MAX_ROTATION_RETRIES = 3;
export const TX_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Bitflow REST API (used for HODLMM pool APR -- no auth required)
// ---------------------------------------------------------------------------
export const BITFLOW_API_BASE = "https://bff.bitflowapis.finance";

// Default HODLMM pool to monitor (dlmm_1 = STX/USDh, highest TVL ~$190K)
export const DEFAULT_HODLMM_POOL_ID = "dlmm_1";
