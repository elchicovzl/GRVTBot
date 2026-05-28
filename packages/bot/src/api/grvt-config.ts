// GRVT environment configuration.
// Switches between mainnet and testnet via GRVT_ENV env var.
// GRVT_ENV=testnet  → testnet.grvt.io hosts, chainId 326
// GRVT_ENV=mainnet (or unset) → grvt.io hosts, chainId 325

const env = process.env.GRVT_ENV === 'testnet' ? 'testnet' : 'mainnet';
const hostInfix = env === 'testnet' ? '.testnet' : '';

export const GRVT_ENV = env;
export const GRVT_EDGE_BASE_URL = `https://edge${hostInfix}.grvt.io`;
export const GRVT_TRADING_BASE_URL = `https://trades${hostInfix}.grvt.io/full/v1`;
export const GRVT_MARKET_DATA_BASE_URL = `https://market-data${hostInfix}.grvt.io/full/v1`;
export const GRVT_CHAIN_ID = env === 'testnet' ? 326 : 325;
