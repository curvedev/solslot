// Production worker under a process-wide filesystem lock (see server startup).
// This signer pays bounded fees only. It cannot claim player rewards or act as dev.
import {PublicKey,Keypair} from '@solana/web3.js';
import {readFileSync,writeFileSync,renameSync,mkdirSync,lstatSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {mainnetGame} from './mainnet-game.js';
import {mainnetConnection,mainnetSpinValidator} from './mainnet-spin.js';
import {createMainnetDraftService,createOracleAdmission} from './mainnet-draft.js';
import {createOracleProofStore} from './oracle-proof-store.js';
import {readGame} from './solana-game.js';
import {draftFeeCollection} from './solana-launch.js';
import manifest from '../config/mainnet.prepared.json' with {type:'json'};
import {feeSharingConfigPda} from '@pump-fun/pump-sdk';
import {executableMainnetRelease} from './mainnet-release.js';
import {draftPrelaunchActivation} from './prelaunch-readiness.js';
import {createMainnetLaunchWorker,verifyLaunchProgramPins} from './mainnet-launch-worker.js';
import {ORAO_PROBE_PREFIX,ORAO_PROBE_LIMIT,ORAO_PROBE_MAX_COUNT,probeSeed,probeEnabled,draftOraoProbe,readOraoProbe,verifiedProbeRefund} from './orao-probe.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
const reference=s=>({player:s.pending.player.toBase58(),nonce:String(s.pending.nonce),request:s.pending.request.toBase58(),seedSlot:String(s.seedSlot)});
function parseReference(value){need(value&&Object.keys(value).sort().join(',')==='nonce,player,request,seedSlot','Only an accepted spin reference is allowed');need(/^[1-9][0-9]{0,19}$/.test(value.nonce)&&/^[1-9][0-9]{0,19}$/.test(value.seedSlot),'Invalid accepted spin reference');return {player:new PublicKey(value.player).toBase58(),nonce:value.nonce,request:new PublicKey(value.request).toBase58(),seedSlot:value.seedSlot};}
export function createMainnetSettler({game=mainnetGame,connection,payer,ledger,save,proofStore,launchConfig=manifest,services={}}){
 need(payer.publicKey.toBase58()===game.config.automation,'Use only the designated automation wallet');
 need(![game.config.owner,game.config.treasury].includes(payer.publicKey.toBase58()),'The worker cannot use a dev or treasury key');
 const api={readGame,draft:createMainnetDraftService({game,connection}),validate:mainnetSpinValidator(game),draftFees:draftFeeCollection,draftActivation:draftPrelaunchActivation,oracleReady:createOracleAdmission(connection,game),draftProbe:draftOraoProbe,readProbe:readOraoProbe,probeRefund:verifiedProbeRefund,verifyProbePrograms:()=>verifyLaunchProgramPins(connection,launchConfig.prelaunch.programPins),...services};
 const budget=20000000,attemptCap=5000000,settlementCap=100000,maxAttempts=10000;
 need(ledger.gameProgram===game.config.gameProgram&&ledger.mint===game.config.mint&&ledger.payer===payer.publicKey.toBase58()&&Array.isArray(ledger.attempts)&&ledger.attempts.length<=maxAttempts,'Worker ledger identity mismatch');
 for(const a of ledger.attempts){need(typeof a.id==='string'&&a.id.length<2048&&['prepared','submitted','confirmed','failed','expired','abandoned-before-broadcast'].includes(a.status)&&(!a.signature||(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(a.signature)&&Number.isSafeInteger(a.lastValidBlockHeight)&&a.lastValidBlockHeight>0)),'Invalid worker attempt');need(Number.isSafeInteger(a.reservedLamports)&&a.reservedLamports>=0&&a.reservedLamports<=attemptCap&&(a.spentLamports===undefined||(Number.isSafeInteger(a.spentLamports)&&a.spentLamports>=0&&a.spentLamports<=attemptCap)),'Invalid worker expense ledger');}
 for(const a of ledger.attempts){if(a.id.startsWith(ORAO_PROBE_PREFIX))probeSeed(a);if(a.refundedLamports!==undefined)need(a.id.startsWith(ORAO_PROBE_PREFIX)&&Number.isSafeInteger(a.refundedLamports)&&a.refundedLamports>=0&&a.refundedLamports<=a.spentLamports&&typeof a.refundSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(a.refundSignature),'Invalid verified oracle rent refund');}
 // Startup owns the process lock. A saved pre-signature reservation cannot have broadcast.
 for(const a of ledger.attempts)if(!a.signature){a.spentLamports=0;a.status='abandoned-before-broadcast';}save(ledger);
 const externalSpent=game.config.automationExternalSpentLamports??0;
 need(Number.isSafeInteger(externalSpent)&&externalSpent>=0&&externalSpent<=5000000,'Invalid external worker expense');
 const spent=()=>externalSpent+ledger.attempts.reduce((n,a)=>n+(a.spentLamports??a.reservedLamports)-(a.refundedLamports??0),0);
 need(spent()<=budget,'Worker budget exhausted');
 let active=null,feeClock=0;
 async function reconcile(attempt){
  if(!attempt)return false;if(!attempt.signature){attempt.spentLamports=0;attempt.status='abandoned-before-broadcast';save(ledger);return false;}
  if(['confirmed','failed','expired'].includes(attempt.status)&&attempt.spentLamports!==undefined)return attempt.status==='confirmed';
  const result=await connection.getTransaction(attempt.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  if(result){const keys=result.transaction.message.staticAccountKeys??result.transaction.message.accountKeys,index=keys.findIndex(k=>k.equals(payer.publicKey));need(index>=0&&result.meta,'Unexpected worker receipt');const debit=result.meta.preBalances[index]-result.meta.postBalances[index];need(Number.isSafeInteger(debit)&&debit>=0&&debit<=attempt.reservedLamports,'Worker receipt exceeded its reserved expense');attempt.spentLamports=debit;attempt.status=result.meta.err?'failed':'confirmed';save(ledger);return attempt.status==='confirmed';}
  if(await connection.getBlockHeight('finalized')>attempt.lastValidBlockHeight){const status=(await connection.getSignatureStatuses([attempt.signature],{searchTransactionHistory:true})).value[0];need(!status,'Wait for the confirmed worker receipt');attempt.spentLamports=0;attempt.status='expired';save(ledger);return false;}
  throw Error('The submitted worker transaction is still pending');
 }
 async function submit(id,ixs,proofCandidate=null,limit=attemptCap,beforeSign=async()=>{}){
  for(const old of ledger.attempts)if(old.signature&&!['confirmed','failed','expired'].includes(old.status))await reconcile(old);
  need(ledger.attempts.length<maxAttempts&&ledger.attempts.filter(a=>a.id===id&&a.signature).length<3,'Worker attempt limit reached');
  need(spent()+limit<=budget,'Worker expense allowance exhausted');
  const before=await connection.getBalance(payer.publicKey,'confirmed');need(before>=limit,'Worker operating balance is low');
  const prepared=await game.prepare(connection,payer.publicKey,ixs);
  const simulated=await connection.simulateTransaction(prepared.tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[payer.publicKey.toBase58()]}}),post=simulated.value.accounts?.[0]?.lamports;
  need(!simulated.value.err&&Number.isSafeInteger(post)&&before-post>=0&&before-post<=limit,'Worker debit exceeds its bounded allowance');
  if(proofCandidate){const {context,proof}=proofCandidate,payload=Buffer.concat([Buffer.from([15]),Buffer.from(proof.signature,'base64'),Buffer.from([proof.recovery_id]),Buffer.from(proof.value)]);
   need(context.gameProgram===game.config.gameProgram&&ixs.some(ix=>ix.programId.toBase58()===context.gameProgram&&ix.data.equals(payload)&&ix.keys[1]?.pubkey.toBase58()===context.game&&ix.keys[3]?.pubkey.toBase58()===context.request&&ix.keys[4]?.pubkey.toBase58()===context.oracle&&ix.keys[5]?.pubkey.toBase58()===context.queue),'Proof does not match the simulated request');
   proofStore.saveVerified(context,proof,{transactionMessageSha256:createHash('sha256').update(prepared.tx.message.serialize()).digest('hex'),simulationSlot:simulated.context.slot});
  }
  const attempt={id,status:'prepared',reservedLamports:limit};ledger.attempts.push(attempt);save(ledger);
  const provider={publicKey:payer.publicKey,signTransaction:async tx=>{await beforeSign();tx.sign([payer]);return tx}};
  const signature=await game.signAndSend(connection,provider,prepared,payer.publicKey,signature=>{Object.assign(attempt,{signature,lastValidBlockHeight:prepared.latest.lastValidBlockHeight,status:'submitted'});save(ledger);});
  await reconcile(attempt);return {signature};
 }
 function serialized(id,fn){if(active){if(active.id===id)return active.promise;return Promise.reject(Error('Worker is completing another operation'));}const promise=fn().finally(()=>{active=null});active={id,promise};return promise;}
 async function settle(input){const ref=parseReference(input),id=JSON.stringify(ref);return serialized(id,async()=>{
  await game.assertNetwork(connection);
  const prior=ledger.attempts.filter(a=>a.id===id).at(-1);if(prior&&await reconcile(prior))return {signature:prior.signature,settled:true};
  const current=await api.readGame(connection,game.config,payer.publicKey);need(current.state.pending&&JSON.stringify(reference(current.state))===id,'This accepted result is no longer pending');
  let candidate=null;const draft=await api.draft({config:game.config,wallet:payer.publicKey.toBase58(),action:'settle'},{proofStore,onRevealProof:p=>{need(!candidate,'Multiple proofs for one request');candidate=p}});
  const plan=await api.validate(connection,game.config,payer.publicKey,'settle',draft.instructions);need(plan.summary.acceptedNonce===ref.nonce&&plan.summary.committedSeedSlot===ref.seedSlot,'Accepted spin changed');
  if(candidate)need(candidate.context.player===ref.player&&candidate.context.nonce===ref.nonce&&candidate.context.request===ref.request&&candidate.context.seedSlot===ref.seedSlot,'Proof context differs from the accepted spin');
  return {...await submit(id,plan.ixs,candidate,settlementCap),settled:true};
 });}
 async function collectFees({emptyPot=false}={}){return serialized('fees',async()=>{
  await game.assertNetwork(connection);const unresolved=ledger.attempts.filter(a=>a.id.startsWith('fees:')&&a.signature&&!['confirmed','failed','expired'].includes(a.status));for(const old of unresolved)await reconcile(old);
  // An empty pot checks promptly at launch; funded play uses the normal
  // minute cadence. No server-provided destination is accepted.
  if(Date.now()-feeClock<(emptyPot?5000:60000))return {collected:false};feeClock=Date.now();
  const draft=await api.draftFees(connection,launchConfig);if(!draft.hasReceipts||BigInt(draft.estimatedReceiptsLamports)<500000n)return {collected:false};
  if(draft.preparationTx)await submit('fees:'+String(feeClock)+':distribution',draft.preparationTx.instructions);
  const result=await submit('fees:'+String(feeClock),draft.tx.instructions);return {...result,collected:true};
 });}
 async function activate(){return serialized('launch:activate',async()=>{
  await game.assertNetwork(connection);
  const prior=ledger.attempts.filter(a=>a.id==='launch:activate').at(-1);
  if(prior&&await reconcile(prior))return {activated:true,signature:prior.signature};
  const ixs=await api.draftActivation(connection,launchConfig);
  return {...await submit('launch:activate',ixs),activated:true};
 });}
 const probes=()=>ledger.attempts.filter(a=>a.id.startsWith(ORAO_PROBE_PREFIX));
 async function canProbe(){return probeEnabled(launchConfig)&&probes().filter(a=>a.signature).length<ORAO_PROBE_MAX_COUNT&&spent()+ORAO_PROBE_LIMIT+attemptCap+settlementCap*3<=budget&&await connection.getBalance(payer.publicKey,'confirmed')>=ORAO_PROBE_LIMIT+attemptCap+settlementCap*3;}
 async function probeState(){
  const prior=probes().at(-1);if(!prior?.signature||['failed','expired','abandoned-before-broadcast'].includes(prior.status))return {pending:false};
  if(!await reconcile(prior))return {pending:false};
  const state=await api.readProbe(connection,launchConfig,prior);
  if(state.fulfilled&&prior.refundedLamports===undefined){const refund=await api.probeRefund(connection,launchConfig,prior,state.request);if(refund){need(Number.isSafeInteger(refund.lamports)&&refund.lamports>0&&refund.lamports<=prior.spentLamports,'Invalid oracle refund');prior.refundedLamports=refund.lamports;prior.refundSignature=refund.signature;save(ledger);}}
  return {pending:!state.fulfilled};
 }
 async function requestProbe(){return serialized('oracle-health',async()=>{
  if((await probeState()).pending)return;
  need(await canProbe(),'Oracle health-check allowance is unavailable');
  await api.verifyProbePrograms();const plan=await api.draftProbe(connection,launchConfig,payer.publicKey);probeSeed(plan);
  await submit(plan.id,plan.ixs,null,ORAO_PROBE_LIMIT,api.verifyProbePrograms);
 });}
 async function oracleReadiness({allowProbe=false,initial=false}={}){
  if(probeEnabled(launchConfig)){
   if((await probeState()).pending)return {ready:false,reason:'oracle-probe-pending'};
   if(initial&&!probes().some(a=>a.signature)){await requestProbe();if((await probeState()).pending)return {ready:false,reason:'oracle-probe-pending'};}
  }
  try{await api.oracleReady();return {ready:true,reason:'ready'};}
  catch(error){
   if(error.code!=='ORAO_IDLE'||!await canProbe())return {ready:false,reason:'oracle-unavailable'};
   if(!allowProbe)return {ready:false,reason:'oracle-idle',canPrepareSpin:true};
   await requestProbe();if((await probeState()).pending)return {ready:false,reason:'oracle-probe-pending'};
   try{await api.oracleReady();return {ready:true,reason:'ready'};}catch{return {ready:false,reason:'oracle-probe-pending'};}
  }
 }
 async function readiness(entry,options={}){
  // Settlements do not create the setup's token accounts. Reserve three
  // settlement-sized attempts; the separate setup/fee cap and unchanged
  // total budget still gate every actual expense at submission time.
  try{await game.assertNetwork(connection,{entry,fresh:false});proofStore.assertCapacity();need(ledger.attempts.length<maxAttempts-3&&spent()+settlementCap*3<=budget,'budget-low');need(await connection.getBalance(payer.publicKey,'confirmed')>=settlementCap*3,'balance-low');}catch{return {ready:false,reason:'release-or-budget-unavailable'};}
  try{return await oracleReadiness(options);}catch{return {ready:false,reason:'oracle-unavailable'};}
 }
 async function ensureEntryOracle(body){
  game.publicConfig(body.config);need(body.action==='commit'&&body.allowOracleProbe===true&&[1,5,10].includes(body.count),'Only an explicit spin purchase may request an idle check');
  const wallet=new PublicKey(body.wallet),snapshot=await game.readSnapshot(connection,game.config,wallet),s=snapshot.state;
  need(!s.closed&&!s.pending&&s.pot>0n&&snapshot.solBalance>=2000000n&&snapshot.balance+(snapshot.playerState?.prepaid??0n)>=s.entry*BigInt(body.count),'Funded eligible player required before an oracle health expense');
  for(let i=0;i<24;i++){const r=await readiness(true,{allowProbe:i===0});if(r.ready)return;if(r.reason!=='oracle-probe-pending')throw Error('Oracle health is unavailable');await new Promise(resolve=>setTimeout(resolve,500));}
  throw Error('Oracle health is still confirming; no player entry was submitted');
 }
 return {payer:payer.publicKey.toBase58(),settle,collectFees,activate,ensureEntryOracle,initialOracleCheck:()=>readiness(false,{initial:true}),prelaunchReady:options=>readiness(false,options),async drain(){await active?.promise.catch(()=>{})},async status(){
  const result=await readiness(true);return {automaticReveal:result.ready,reason:result.reason,...(result.canPrepareSpin?{canPrepareSpin:true}:{})};
 },async recoverPending(){await game.assertNetwork(connection,{fresh:false});const current=await api.readGame(connection,game.config,payer.publicKey);if(current.state.pending)return settle(reference(current.state));return current.state.closed?{closed:true}:collectFees();}};
}
export async function loadMainnetSettler(env=process.env){
 if(!env.SOLPOT_MAINNET_RELAYER_KEYPAIR&&!env.SOLPOT_MAINNET_RELAYER_STATE)return null;
 need(env.SOLPOT_MAINNET_RELAYER_KEYPAIR&&env.SOLPOT_MAINNET_RELAYER_STATE,'Both private mainnet worker paths are required');
 need(executableMainnetRelease(manifest),'Mainnet release is not verified; signer was not loaded');
 need(env.SOLPOT_MAINNET_LOCKED==='1','Mainnet worker requires its process lock');
 const paths=[env.SOLPOT_MAINNET_RELAYER_KEYPAIR,env.SOLPOT_MAINNET_RELAYER_STATE].map(p=>resolve(p));
 need(paths.every(p=>!p.startsWith(resolve('.')+sep)&&p!==resolve('.')),'Keep all worker secrets and state outside the served project');
 const stat=lstatSync(paths[0]);need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'Worker key must be a private regular file');
 const payer=Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(paths[0],'utf8'))));
 let ledger;try{const st=lstatSync(paths[1]);need(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&st.size<8000000,'Invalid worker state file');ledger=JSON.parse(readFileSync(paths[1],'utf8'));}catch(e){throw Error('Mainnet expense ledger is missing or unreadable; never reset it automatically');}
 const save=value=>{mkdirSync(dirname(paths[1]),{recursive:true,mode:0o700});const tmp=paths[1]+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});const fd=openSync(tmp,'r');try{fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,paths[1]);const directory=openSync(dirname(paths[1]),'r');try{fsyncSync(directory)}finally{closeSync(directory)}};
 const connection=mainnetConnection(),launchConfig=structuredClone(manifest);
 if(manifest.prelaunch?.enabled)launchConfig.pumpfun.sharingConfig=feeSharingConfigPda(new PublicKey(manifest.mint)).toBase58();
 const settler=createMainnetSettler({game:mainnetGame,connection,payer,ledger,save,launchConfig,proofStore:createOracleProofStore({directory:paths[1]+'.proofs',maxRecords:10000})});
 const worker=manifest.prelaunch?.enabled?await createMainnetLaunchWorker({config:manifest,connection,settler,runtime:dirname(paths[1])}):settler;
 if(probeEnabled(manifest))await settler.initialOracleCheck();
 return worker;
}
