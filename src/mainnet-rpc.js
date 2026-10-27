// The browser and server use the same browser-compatible mainnet provider.
// Release/genesis validation remains in the callers; never fall back to devnet.
import {Connection} from '@solana/web3.js';

export const MAINNET_RPC_ENDPOINT = 'https://solana-rpc.publicnode.com';
export function mainnetConnection() {
  return new Connection(MAINNET_RPC_ENDPOINT, {commitment:'confirmed', disableRetryOnRateLimit:true});
}
