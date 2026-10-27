// The same game state machine and animation receipts, with an explicit pinned
// mainnet transport. This is not included in the live devnet page yet.
import {createPlaygroundGame} from './playground-game.js';
import {mainnetGame} from './mainnet-game.js';
import {mainnetConnection,planMainnetSpin,ensureMainnetRevealAvailable,finishMainnetSpin} from './mainnet-spin.js';
import {connectStandardSolanaWallet} from './standard-devnet-wallet.js';
export const connectMainnetWallet=wallet=>connectStandardSolanaWallet(wallet,{chain:'solana:mainnet',networkLabel:'mainnet'});
export function createMainnetPlayground(options){
 return createPlaygroundGame({...options,config:mainnetGame.config,connection:options.connection??mainnetConnection(),validateConfig:mainnetGame.publicConfig,services:{
  readPlayerSnapshot:mainnetGame.readSnapshot,planGameAction:mainnetGame.planAction,planDevnetSpin:planMainnetSpin,
  prepareDevnetTransaction:mainnetGame.prepare,signAndSendDevnet:mainnetGame.signAndSend,
  finishDevnetSpin:finishMainnetSpin,ensureRevealAvailable:ensureMainnetRevealAvailable,
 }});
}
