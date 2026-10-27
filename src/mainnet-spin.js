import {PublicKey} from '@solana/web3.js';
export {mainnetConnection} from './mainnet-rpc.js';
import {mainnetGame} from './mainnet-game.js';
import {validateConfiguredSpinDraft} from './devnet-spin.js';
import {ORAO_PROGRAM} from './orao-vrf.js';
import {validateOraoSpin} from './orao-spin.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
export function mainnetSpinValidator(game=mainnetGame){
 return (connection,config,wallet,action,wire,options={})=>{
  // New mainnet packs settle in one oracle request; there are no legacy
  // browser-key sponsorship endpoints or grants on this launch path.
  need(!options.sessionActor&&!options.grantSession,'Mainnet packs use one wallet approval');
  if(game.config.oracleProgram===ORAO_PROGRAM.toBase58())return validateOraoSpin(game,connection,config,wallet,action,wire,options);
  return validateConfiguredSpinDraft(connection,config,wallet,action,wire,options,{validateConfig:game.publicConfig,readSnapshot:game.readSnapshot,networkLabel:'Solana mainnet — real SOL and SOLPOT',tokenLabel:'SOLPOT'});
 };
}
export const validateMainnetSpin=mainnetSpinValidator();
export async function planMainnetSpin(connection,config,wallet,action,fetcher=fetch,options={}){
 mainnetGame.publicConfig(config);await mainnetGame.assertNetwork(connection,{entry:action==='commit'});
 const response=await fetcher('/api/mainnet/spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config,wallet:new PublicKey(wallet).toBase58(),action,count:options.batchCount??1,allowOracleProbe:options.allowOracleProbe===true}),signal:AbortSignal.timeout(30000)});
 const result=await response.json();need(response.ok&&result.cluster==='solana:mainnet',result.error||'Mainnet spin service unavailable');
 return validateMainnetSpin(connection,config,wallet,action,result.instructions,options);
}
export async function ensureMainnetRevealAvailable(fetcher=fetch){const response=await fetcher('/api/mainnet/status',{cache:'no-store',signal:AbortSignal.timeout(10000)}),state=await response.json();need(response.ok&&state.network==='mainnet-beta'&&(state.automaticReveal===true||state.canPrepareSpin===true),'New mainnet spins are paused while automatic settlement is unavailable');return state;}
export async function finishMainnetSpin(ref,fetcher=fetch){const response=await fetcher('/api/mainnet/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ref),signal:AbortSignal.timeout(120000)}),result=await response.json();need(response.ok,result.error||'This accepted spin is still waiting for settlement');return result;}
