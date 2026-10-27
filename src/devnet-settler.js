// A dedicated test-only payer reveals accepted spins or co-signs exact entries
// already signed by a bounded browser play key. It cannot claim or administer.
import {PublicKey,Keypair} from '@solana/web3.js';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {publicDevnetConfig,assertDevnet,readGame,prepareDevnetTransaction,signAndSendDevnet} from './solana-game.js';
import {validateSpinDraft} from './devnet-spin.js';
import {createSpinDraft} from './devnet-api.js';
import {devnetConnection} from './devnet-rpc.js';
import {sessionRequest,validateSessionEntry} from './devnet-session-sponsor.js';
import {createHash} from 'node:crypto';
import {createOracleProofStore} from './oracle-proof-store.js';

export const pendingIdentity=s=>({player:s.pending.player.toBase58(),nonce:String(s.pending.nonce),request:s.pending.request.toBase58(),seedSlot:String(s.seedSlot)});
function identity(body){
 if(!body||Object.keys(body).sort().join(',')!=='nonce,player,request,seedSlot'||!/^\d{1,20}$/.test(body.nonce)||!/^\d{1,20}$/.test(body.seedSlot))throw Error('Only an accepted spin reference is allowed');
 return {player:new PublicKey(body.player).toBase58(),nonce:String(body.nonce),request:new PublicKey(body.request).toBase58(),seedSlot:String(body.seedSlot)};
}
export function createDevnetSettler({config,connection,payer,ledger={attempts:[]},save=()=>{},proofStore=null,services={}}){
 config=publicDevnetConfig(config);
 if([config.owner,config.treasury].includes(payer.publicKey.toBase58()))throw Error('Use a separate devnet reveal payer, never the game administrator');
 const api={assertDevnet,readGame,createSpinDraft,validateSpinDraft,prepareDevnetTransaction,signAndSendDevnet,...services};
 let active=null;
 async function execute(ref,id){
  await api.assertDevnet(connection,{fresh:false});
  const prior=ledger.attempts.filter(a=>a.id===id).at(-1);
  if(prior?.signature){
   let status=(await connection.getSignatureStatuses([prior.signature],{searchTransactionHistory:true})).value[0];
   if(!status && await connection.getBlockHeight('finalized')>prior.lastValidBlockHeight)status=(await connection.getSignatureStatuses([prior.signature],{searchTransactionHistory:true})).value[0]??{expired:true};
   if(!status?.expired&&!['confirmed','finalized'].includes(status?.confirmationStatus))throw Error('Reveal confirmation is pending. Retry the same result shortly.');
   if(!status.expired&&!status.err){prior.status='confirmed';save(ledger);return {signature:prior.signature,settled:true};}
   prior.status=status.expired?'expired':'failed';save(ledger);
  }
  const game=await api.readGame(connection,config,payer.publicKey);
  if(!game.state.pending||JSON.stringify(pendingIdentity(game.state))!==id)throw Error('The requested spin is no longer pending. Refresh its on-chain result.');
  if(ledger.attempts.length>=100||ledger.attempts.filter(a=>a.id===id).length>=3)throw Error('Devnet reveal allowance reached. The accepted spin is preserved.');
  const balance=await connection.getBalance(payer.publicKey,'confirmed');
  if(balance<1000000)throw Error('Devnet reveal service needs more free test funds.');
  let proofCandidate=null;
  const draft=await api.createSpinDraft({config,wallet:payer.publicKey.toBase58(),action:'settle'},proofStore?{proofStore,onRevealProof:candidate=>{if(proofCandidate)throw Error('Multiple reveal proofs in one accepted spin');proofCandidate=structuredClone(candidate);}}:{});
  const plan=await api.validateSpinDraft(connection,config,payer.publicKey,'settle',draft.instructions);
  if(plan.summary.acceptedNonce!==ref.nonce||plan.summary.committedSeedSlot!==ref.seedSlot)throw Error('Accepted spin changed while preparing its reveal');
  const prepared=await api.prepareDevnetTransaction(connection,payer.publicKey,plan.ixs);
  const simulation=await connection.simulateTransaction(prepared.tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[payer.publicKey.toBase58()]}});
  const post=simulation.value.accounts?.[0]?.lamports;
  if(simulation.value.err||!Number.isSafeInteger(post)||balance-post<0||balance-post>100000||prepared.baseFeeLamports>100000)throw Error('Reveal exceeds the bounded devnet fee allowance');
  if(proofCandidate){
   const {context,proof}=proofCandidate;
   const payload=Buffer.concat([Buffer.from([15]),Buffer.from(proof.signature,'base64'),Buffer.from([proof.recovery_id]),Buffer.from(proof.value)]);
   const matches=plan.ixs.some(ix=>ix.programId.toBase58()===context.gameProgram&&ix.data.equals(payload)&&ix.keys[1]?.pubkey.toBase58()===context.game&&ix.keys[3]?.pubkey.toBase58()===context.request&&ix.keys[4]?.pubkey.toBase58()===context.oracle&&ix.keys[5]?.pubkey.toBase58()===context.queue);
   if(context.gameProgram!==config.gameProgram||context.player!==ref.player||context.nonce!==ref.nonce||context.request!==ref.request||context.seedSlot!==ref.seedSlot||!matches)throw Error('Verified reveal does not match the archived accepted request');
   // A persisted proof is not a bypass: every retry rebuilds and simulates the
   // same authenticated CPI, so expired or rejected oracle keys remain rejected.
   proofStore.saveVerified(context,proof,{transactionMessageSha256:createHash('sha256').update(prepared.tx.message.serialize()).digest('hex'),simulationSlot:simulation.context?.slot});
  }
  const attempt={id,status:'prepared',reservedLamports:100000};ledger.attempts.push(attempt);save(ledger);
  const provider={publicKey:payer.publicKey,signTransaction:async tx=>{tx.sign([payer]);return tx;}};
  const signature=await api.signAndSendDevnet(connection,provider,prepared,payer.publicKey,signature=>{Object.assign(attempt,{signature,lastValidBlockHeight:prepared.latest.lastValidBlockHeight,status:'submitted'});save(ledger);});
  attempt.status='confirmed';save(ledger);return {signature,settled:true};
 }
 function serialized(id,execute){
  if(active){if(active.id!==id)return Promise.reject(Error('Another accepted spin is being settled'));return active.promise;}
  const promise=execute().finally(()=>{active=null;});active={id,promise};return promise;
 }
 const settler={payer:payer.publicKey.toBase58(),async status(){
  // Leave the full three-attempt reveal allowance before accepting more work.
  // Already accepted requests may still reconcile/settle after readiness closes.
  if(ledger.attempts.length>97)return {automaticReveal:false,reason:'allowance-exhausted'};
  try{
   await api.assertDevnet(connection,{fresh:false});
   const balance=await connection.getBalance(payer.publicKey,'confirmed');
   if(!Number.isSafeInteger(balance)||balance<1000000)return {automaticReveal:false,reason:'test-funding-needed'};
   return {automaticReveal:true,reason:'ready'};
  }catch{return {automaticReveal:false,reason:'network-unavailable'};}
 },async recoverPending(){
  // Share the HTTP handler's exact settler/ledger and in-process serialization.
  // A restart discovers accepted work on chain, not in a player's browser.
  await api.assertDevnet(connection,{fresh:false});
  const game=await api.readGame(connection,config,payer.publicKey);
  if(!game.state.pending)return {settled:false};
  return settler.settle(pendingIdentity(game.state));
 },async drain(){await active?.promise.catch(()=>{});},receipt(body){
  const {id}=sessionRequest(body),saved=ledger.attempts.find(a=>a.id===id);
  return saved?.signature?{signature:saved.signature,lastValidBlockHeight:saved.lastValidBlockHeight}:{known:false};
 },settle(body){
  const ref=identity(body),id=JSON.stringify(ref);return serialized(id,()=>execute(ref,id));
 },sponsor(body){
  const {id,tx}=sessionRequest(body);
  return serialized(id,async()=>{
   try {
   await api.assertDevnet(connection,{fresh:false});
   const prior=ledger.attempts.find(a=>a.id===id);
   // A replay only returns its saved receipt, even if it failed or expired.
   if(prior?.signature)return {signature:prior.signature,lastValidBlockHeight:prior.lastValidBlockHeight};
   if(prior)throw Error('This prepaid entry is already being checked');
   if(ledger.attempts.length>=100)throw Error('Devnet service allowance reached');
   await validateSessionEntry(connection,config,payer.publicKey,body,tx);
   const balance=await connection.getBalance(payer.publicKey,'confirmed');
   if(balance<1000000)throw Error('Devnet service needs more free test funds');
   const fee=(await connection.getFeeForMessage(tx.message,'confirmed')).value;
   if(!Number.isSafeInteger(fee)||fee>10000)throw Error('Unexpected prepaid entry network fee');
   const simulation=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[payer.publicKey.toBase58()]}});
   const post=simulation.value.accounts?.[0]?.lamports;
   if(simulation.value.err||!Number.isSafeInteger(post)||balance-post<0||balance-post>10000)throw Error('Prepaid entry simulation failed or exceeded its fee allowance');
   const attempt={id,status:'prepared',reservedLamports:10000};ledger.attempts.push(attempt);save(ledger);
   const prepared={tx,latest:{blockhash:tx.message.recentBlockhash,lastValidBlockHeight:body.lastValidBlockHeight},baseFeeLamports:fee};
   const provider={publicKey:payer.publicKey,signTransaction:async value=>{value.sign([payer]);return value;}};
   const signature=await api.signAndSendDevnet(connection,provider,prepared,payer.publicKey,signature=>{Object.assign(attempt,{signature,lastValidBlockHeight:body.lastValidBlockHeight,status:'submitted'});save(ledger);});
   attempt.status='confirmed';save(ledger);return {signature,lastValidBlockHeight:body.lastValidBlockHeight};
   }catch(error){error.notSubmitted=!ledger.attempts.some(a=>a.id===id&&a.signature);throw error;}
  });
 }};
 return settler;
}
export function loadDevnetSettler(env=process.env){
 if(!env.SOLPOT_DEVNET_RELAYER_KEYPAIR&&!env.SOLPOT_DEVNET_RELAYER_STATE)return null;
 if(!env.SOLPOT_DEVNET_RELAYER_KEYPAIR||!env.SOLPOT_DEVNET_RELAYER_STATE)throw Error('Set both private devnet relayer paths');
 const paths=[env.SOLPOT_DEVNET_RELAYER_KEYPAIR,env.SOLPOT_DEVNET_RELAYER_STATE].map(p=>resolve(p));
 if(paths.some(p=>p===resolve('.')||p.startsWith(resolve('.')+sep)))throw Error('Keep test secrets and relayer state outside the project');
 const config=publicDevnetConfig(JSON.parse(readFileSync('dist/devnet-config.json','utf8')));
 const payer=Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(paths[0],'utf8'))));
 let ledger;try{ledger=JSON.parse(readFileSync(paths[1],'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;ledger={gameProgram:config.gameProgram,mint:config.mint,payer:payer.publicKey.toBase58(),attempts:[]};}
 if(ledger.gameProgram!==config.gameProgram||ledger.mint!==config.mint||ledger.payer!==payer.publicKey.toBase58()||!Array.isArray(ledger.attempts))throw Error('Relayer ledger identity mismatch');
 const save=value=>{mkdirSync(dirname(paths[1]),{recursive:true,mode:0o700});const tmp=paths[1]+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,paths[1]);};
 const proofStore=createOracleProofStore({directory:paths[1]+'.proofs'});
 return createDevnetSettler({config,connection:devnetConnection(),payer,ledger,save,proofStore});
}
