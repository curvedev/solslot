import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { connectStandardAddress, DEVNET_CHAIN } from './wallet-discovery.js';

function verifiedKey(account) {
  if (!account) return null;
  if (!(account.publicKey instanceof Uint8Array) || account.publicKey.length !== 32) throw Error('Wallet must return a 32-byte Solana public key');
  const key = new PublicKey(account.publicKey);
  if (key.toBase58() !== account.address) throw Error('Wallet account address does not match its public key');
  return key;
}
export async function connectStandardDevnetWallet(wallet) {
  return connectStandardSolanaWallet(wallet,{chain:DEVNET_CHAIN,networkLabel:'devnet'});
}
export async function connectStandardSolanaWallet(wallet,{chain,networkLabel}) {
  if(!['solana:devnet','solana:mainnet'].includes(chain))throw Error('Unsupported Solana network');
  const feature = wallet.features?.['solana:signTransaction'];
  if (feature?.version !== '1.0.0' || !feature.supportedTransactionVersions?.includes(0) || typeof feature.signTransaction !== 'function') {
    throw Error(`This wallet needs v0 transaction signing without broadcasting to play the ${networkLabel} game`);
  }
  const connection = await connectStandardAddress(wallet,{chain});
  const allowed = () => {
    const account = connection.account;
    if (!account?.features?.includes('solana:signTransaction')) throw Error(`Reconnect a ${networkLabel} account with transaction-signing permission`);
    verifiedKey(account);
    return account;
  };
  try { allowed(); } catch (error) { connection.dispose(); throw error; }
  return {
    get publicKey() { try { return verifiedKey(connection.account); } catch { return null; } },
    subscribe: connection.subscribe,
    dispose: connection.dispose,
    disconnect: connection.disconnect,
    async signTransaction(tx) {
      if (tx.version !== 0) throw Error(`Only reviewed v0 ${networkLabel} transactions are supported`);
      const account = allowed(), address = account.address;
      const output = await feature.signTransaction({ account, transaction: tx.serialize(), chain });
      if (connection.account?.address !== address) throw Error('Wallet account changed while signing; prepare again');
      if (output?.length !== 1 || !(output[0].signedTransaction instanceof Uint8Array)) throw Error('Wallet returned an invalid signed transaction');
      // Message equality and signature simulation are enforced by signAndSendDevnet.
      return VersionedTransaction.deserialize(output[0].signedTransaction);
    },
  };
}
