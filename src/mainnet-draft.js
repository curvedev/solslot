// Server-only oracle drafts; no signer is loaded or transaction submitted.
import {PublicKey} from '@solana/web3.js';
import {AnchorUtils,Queue,Oracle} from '@switchboard-xyz/on-demand';
import {mainnetGame,MAINNET_GENESIS} from './mainnet-game.js';
import {mainnetConnection} from './mainnet-spin.js';
import {readyConfiguredReveal} from './ready-reveal.js';
import {draftSpinCommit,draftSpinSettlement} from './solana-oracle.js';
import {encodeInstruction} from './devnet-spin.js';
import {ORAO_PROGRAM} from './orao-vrf.js';
import {createOraoAdmission} from './orao-admission.js';
import {draftOraoSpin} from './orao-spin.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
export function boundOracleBatchReads(program){
 const account=program.account.oracleAccountData,fetchMultiple=account.fetchMultiple.bind(account);
 // The public RPC limits batched reads. Keep each oracle's Anchor decoding and
 // every health requirement, without inventing a shared slot for separate reads.
 account.fetchMultiple=async(keys,commitment)=>{
  need(Array.isArray(keys)&&keys.length<=256,'Unexpected oracle queue size');const values=[];
  for(let i=0;i<keys.length;i+=8){const part=await fetchMultiple(keys.slice(i,i+8),commitment);need(part.length===Math.min(8,keys.length-i),'Incomplete oracle read');values.push(...part);}
  return values;
 };
 return program;
}
export function requireHealthyCandidate(candidate){
 need(candidate?.isOnQueue&&candidate.isVerified&&candidate.heartbeatFresh&&candidate.quoteFresh&&candidate.liveHealthy&&candidate.gatewayEnabled&&candidate.pullOracleEnabled&&!candidate.restricted,'No live healthy oracle is available; new entries stay paused');
 const url=new URL(candidate.gatewayUrl);need(url.protocol==='https:'&&!url.username&&!url.password,'Unexpected oracle gateway');
 return candidate.oracle.pubkey;
}
export function requireFreshQueueMember(queue,data,now=Math.floor(Date.now()/1000)){
 need(Array.isArray(data)&&data.length===queue.oracleKeysLen&&data.length>0,'Incomplete randomness queue');
 need(data.some(value=>value?.isOnQueue&&value.enclave.verificationStatus===4&&
  now-value.lastHeartbeat.toNumber()<=queue.nodeTimeout.toNumber()&&value.enclave.validUntil.toNumber()>now&&
  Buffer.from(value.gatewayUri).toString().replace(/\0+$/,'').length>0),
 'No verified randomness queue member has a fresh heartbeat and quote');
}
export function createOracleAdmission(connection,game=mainnetGame){
 if(game.config.oracleProgram===ORAO_PROGRAM.toBase58())return createOraoAdmission(connection);
 let cached=null,checking=null,failedUntil=0;
 const check=async()=>{
  const program=boundOracleBatchReads(await AnchorUtils.loadProgramFromConnection(connection));
  need(program.programId.toBase58()===game.config.oracleProgram,'Unexpected oracle deployment');
  const queue=new Queue(program,new PublicKey(game.config.queue)),state=await queue.loadData();
  // Fail quickly during an outage before contacting every gateway. The full SDK
  // selection below still repeats all chain checks and requires live health.
  requireFreshQueueMember(state,await Oracle.loadMany(program,state.oracleKeys.slice(0,state.oracleKeysLen)));
  const result=await queue.inspectRandomnessOracles();
  const node=requireHealthyCandidate(result.selectedCandidate);cached={node,until:Date.now()+15000};return node;
 };
 return async()=>{if(cached&&cached.until>Date.now())return cached.node;if(failedUntil>Date.now())throw Error('Live randomness is unavailable');if(checking)return checking;checking=check().catch(error=>{failedUntil=Date.now()+5000;throw error}).finally(()=>{checking=null});return checking;};
}
export function createMainnetDraftService({game=mainnetGame,connection=mainnetConnection()}={}){
 let cachedProgram;const admission=createOracleAdmission(connection,game);
 return async function draft(body,services={}){
  game.publicConfig(body?.config);need(['commit','settle'].includes(body.action),'Choose commit or settle');
  await game.assertNetwork(connection,{entry:body.action==='commit'});
  if(game.config.oracleProgram===ORAO_PROGRAM.toBase58()){
   if(body.action==='commit')await admission();
   return {unsigned:true,cluster:'solana:mainnet',instructions:await draftOraoSpin(connection,game.config,body.wallet,body.action,body.count??1)};
  }
  const program=await(cachedProgram??=AnchorUtils.loadProgramFromConnection(connection).catch(error=>{cachedProgram=null;throw error}));
  need(program.programId.toBase58()===game.config.oracleProgram,'Unexpected mainnet oracle program');
  const payer=new PublicKey(body.wallet);
  const draftReveal=(program,config,payer,request,internal)=>readyConfiguredReveal(program,config,payer,request,internal,{validateConfig:game.publicConfig,genesisHash:MAINNET_GENESIS});
  const ixs=body.action==='commit'?await draftSpinCommit(program,connection,game.config,payer,game.config.randomness,body.count??1,{selectOracle:admission}):await draftSpinSettlement(program,connection,game.config,payer,{...services,draftReveal});
  return {unsigned:true,cluster:'solana:mainnet',instructions:ixs.map(encodeInstruction)};
 };
}
