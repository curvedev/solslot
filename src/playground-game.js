import { PublicKey } from '@solana/web3.js';
import { publicDevnetConfig, readPlayerSnapshot, planGameAction, prepareDevnetTransaction, signAndSendDevnet } from './solana-game.js';
import { planDevnetSpin, decodeRandomness } from './devnet-spin.js';
import { finishDevnetSpin, ensureRevealAvailable } from './devnet-reveal.js';
import {createPlaySessions,prepareSessionEntry,sendSessionEntry,readSessionReceipt,verifySessionReceipt} from './play-session.js';
import {ORAO_PROGRAM} from './orao-vrf.js';

export function verifiedDraw(bytes) {
 if(bytes.length!==32)throw Error('Expected the authenticated 32-byte result');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 for(let offset=0;offset<32;offset+=4){const n=view.getUint32(offset,true);if(n<4294967200)return n%400+1;}
 throw Error('No usable word in this result; preserve the accepted request');
}
export function presentationRules(state) {
 return {entry:Number(state?.entry??200000000000n)/1e6,consolation:Number(state?.consolation??100000000000n)/1e6};
}
export function spinPresentation(bytes,pending,state) {
 const {entry,consolation}=presentationRules(state);
 const number=verifiedDraw(bytes),won=number<=4,reward=number>=5&&number<=84?consolation:0;
 return {id:String(pending.nonce),number,won,reward,burn:entry-reward,payout:won?Number(pending.lockedPot)/1e9:0,potBefore:Number(pending.lockedPot)/1e9};
}
export function receiptResults(receipt,state) {
 const {entry,consolation}=presentationRules(state);
 if(!receipt)return [];
 return receipt.draws.slice(0,receipt.played).map((number,index)=>{
  const won=number<=4,reward=number>=5&&number<=84?consolation:0;
  return {id:receipt.requested===1?String(receipt.nonce):`${receipt.nonce}:${index+1}`,number,won,reward,burn:entry-reward,payout:won?Number(receipt.lockedPot)/1e9:0,potBefore:Number(receipt.lockedPot)/1e9};
 });
}
// ORAO commits bind the execution slot; Switchboard binds execution slot - 1.
// Query only the signature captured from our verified, confirmed submission.
export async function readCommitSeedSlot(connection,signature,oracleProgram) {
 const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
 if(!status||status.err||!['confirmed','finalized'].includes(status.confirmationStatus)||!Number.isSafeInteger(status.slot)||status.slot<2)throw Error('Waiting for the accepted transaction slot. Retry checking this same spin.');
 return BigInt(status.slot)-(oracleProgram===ORAO_PROGRAM.toBase58()?0n:1n);
}
export function createPlaygroundGame({config,connection,storage,sessionStorage,review=async()=>true,onChange=()=>{},services={},now=()=>Date.now(),validateConfig=publicDevnetConfig}) {
 config=validateConfig(config);
 const api={readPlayerSnapshot,planGameAction,planDevnetSpin,finishDevnetSpin,ensureRevealAvailable,prepareDevnetTransaction,signAndSendDevnet,prepareSessionEntry,sendSessionEntry,readSessionReceipt,verifySessionReceipt,readCommitSeedSlot,...services};
 const sessions=createPlaySessions(config,sessionStorage);
 let provider=null,snapshot=null,busy=false,receipt=null,revision=0,readEpoch=0,phase='idle',warm=null,warmEpoch=0,acceptedEntry=null;
 const WARM_MAX_AGE_MS=5000;
 const invalidateWarm=()=>{warm=null;warmEpoch++;};
 const key=who=>`solpot:${config.cluster.split(':')[1]}:${config.gameProgram}:${config.mint}:${who}`;
 const view=()=>({config,provider,snapshot,busy,receipt,phase,sessionReady:!!(provider?.publicKey&&sessions.ready(provider.publicKey.toBase58(),snapshot))});
 const notify=()=>onChange(view());
 function restore() {
  receipt=null;
  const raw=provider?.publicKey?storage.getItem(key(provider.publicKey.toBase58())):null;
  if(raw){const r=JSON.parse(raw);if((!r.sponsored&&(typeof r.signature!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature)))||!Number.isSafeInteger(r.lastValidBlockHeight))throw Error('Stored transaction receipt is invalid');receipt=r;}
 }
 async function refresh() {
  invalidateWarm();
  const version=revision,epoch=++readEpoch,who=provider?.publicKey??new PublicKey(config.owner);
  const next=await api.readPlayerSnapshot(connection,config,who);
  if(version!==revision||epoch!==readEpoch)return;
  snapshot=next;notify();return next;
 }
 function setWallet(value) {invalidateWarm();acceptedEntry=null;revision++;provider=value;snapshot=null;receipt=null;restore();notify();}
 // This only prepares an unsigned purchase. No wallet method, session signing,
 // transaction submission or randomness request runs until the player clicks.
 // Age starts before the draft's FINAL on-chain validation, not its download.
 // The final state, refreshed readiness and simulation must all fit that window.
 function warmSpin(count=1) {
  if(!config.batchSpins||busy||receipt||!provider?.publicKey||provider.viewOnly||![1,5,10].includes(count))return Promise.resolve(false);
  const who=provider.publicKey,version=revision,chosen=provider;
  if(warm?.count===count&&warm.version===version&&warm.who.equals(who)&&(warm.pending||now()<warm.expiresAt))return warm.promise.then(Boolean);
  invalidateWarm();
  const epoch=warmEpoch,candidate={who,version,count,epoch,startedAt:now(),expiresAt:now()+WARM_MAX_AGE_MS,pending:true,promise:null};
  const current=()=>epoch===warmEpoch&&version===revision&&provider===chosen&&provider.publicKey?.equals(who);
  const valid=()=>current()&&now()<candidate.expiresAt;
  candidate.promise=(async()=>{
   const [availability,before]=await Promise.all([api.ensureRevealAvailable(),api.readPlayerSnapshot(connection,config,who)]);
   if(availability?.canPrepareSpin&&availability.automaticReveal!==true)return null;
   if(!valid()||before.state.closed||before.state.pending||before.state.pot<=0n||(before.playerState?.prepaid??0n)>=before.state.entry||before.balance<before.state.entry*BigInt(count))return null;
   const plan=await api.planDevnetSpin(connection,config,who,'commit',undefined,{purchaseCount:count,grantSession:null,batchCount:count});
   const validationStart=plan.validationStartedAt;
   if(!current()||!plan.snapshot||!Number.isFinite(validationStart)||validationStart>now())return null;
   candidate.expiresAt=validationStart+WARM_MAX_AGE_MS;
   if(!valid())return null;
   const [service,prepared]=await Promise.all([api.ensureRevealAvailable(),api.prepareDevnetTransaction(connection,who,plan.ixs)]);
   return valid()?{service,before:plan.snapshot,plan,prepared}:null;
  })().catch(()=>null).finally(()=>{candidate.pending=false;});
  warm=candidate;
  return candidate.promise.then(Boolean);
 }
 async function takeWarmSpin(count,batchCount) {
  const candidate=warm;warm=null;
  if(!candidate||candidate.count!==count||batchCount!==count||candidate.version!==revision||!candidate.who.equals(provider.publicKey)||(!candidate.pending&&now()>=candidate.expiresAt)){invalidateWarm();return null;}
  const prepared=await candidate.promise;
  if(candidate.epoch!==warmEpoch||now()>=candidate.expiresAt)return null;
  return prepared;
 }
 async function checkReceipt() {
  if(busy)throw Error('Wait for the current action');
  if(!receipt)return refresh();
  const old=receipt,version=revision,storageKey=key(provider.publicKey.toBase58());busy=true;notify();
  try {
   if(old.sponsored&&!old.signature){
    const result=await api.readSessionReceipt(old.sponsored);
    if(result.signature){old.signature=result.signature;storage.setItem(storageKey,JSON.stringify(old));}
    else {
     if(await connection.getBlockHeight('finalized')<=old.lastValidBlockHeight)throw Error('Still checking the previous prepaid entry. No new spin will start.');
     // The original request could still have been in flight. Check the durable
     // ledger once more after finalized expiry, never submit the saved bytes.
     const final=await api.readSessionReceipt(old.sponsored);
     if(final.signature){old.signature=final.signature;storage.setItem(storageKey,JSON.stringify(old));}
     else {storage.removeItem(storageKey);if(version===revision){receipt=null;await refresh();}return {expired:true};}
    }
   }
   let status=(await connection.getSignatureStatuses([old.signature],{searchTransactionHistory:true})).value[0];
   if(!status && await connection.getBlockHeight('finalized')>old.lastValidBlockHeight)status=(await connection.getSignatureStatuses([old.signature],{searchTransactionHistory:true})).value[0]??{expired:true};
   if(!status?.expired && !['confirmed','finalized'].includes(status?.confirmationStatus))throw Error('Still waiting for confirmation. Your entry will not be submitted again.');
   if(old.sponsored&&!status.expired)await api.verifySessionReceipt(connection,old.sponsored,old.signature,{requireSuccess:!status.err});
   storage.removeItem(storageKey);
   if(version!==revision)return;
   receipt=null;await refresh();
   return {expired:!!status.expired,failed:!!status.err};
  }finally{busy=false;phase='idle';notify();}
 }
 async function act(action,count=1,{sessionOnly=false,shouldContinue=()=>true,batchCount=1}={}) {
  if(busy)throw Error('Wait for the current action');
  if(!provider?.publicKey)throw Error('Connect your wallet first');
  if(receipt)throw Error('Check the pending transaction before another action');
  busy=true;phase='preparing';notify();const chosen=provider,who=provider.publicKey,version=revision,storageKey=key(who.toBase58());
  const unchanged=(accepted=false)=>{
   if(version!==revision||provider!==chosen||!provider.publicKey?.equals(who))throw Error('Wallet changed. Reconnect before continuing.');
   if(!accepted&&action==='spin'&&!shouldContinue()){const error=Error('Spin sequence stopped before another entry.');error.code='SPIN_STOPPED';throw error;}
  };
  try {
   const cached=action==='spin'&&!sessionOnly?await takeWarmSpin(count,batchCount):null;unchanged();
   if(!cached)invalidateWarm();
   const [service,before]=cached?[cached.service,cached.before]:await Promise.all([action==='spin'?api.ensureRevealAvailable():null,api.readPlayerSnapshot(connection,config,who)]);unchanged();
   if(action==='spin'&&sessionOnly&&!sessions.ready(who.toBase58(),before))throw Error('Automatic spins stopped: play access expired or prepaid credits are unavailable.');
   const purchaseCount=action==='spin'&&(before.playerState?.prepaid??0n)<before.state.entry?count:0;
   if(action==='spin'&&sessions.ready(who.toBase58(),before)&&(before.playerState?.sessionSpins??0n)>=BigInt(batchCount)){
    if(!service?.sessionPayer)throw Error('Prepaid play service is offline. No entry was taken.');
    const pair=sessions.load(who.toBase58());
    const plan=await api.planDevnetSpin(connection,config,who,'commit',undefined,{sessionActor:pair.publicKey,batchCount});unchanged();
    const prepared=await api.prepareSessionEntry(connection,who,service.sessionPayer,pair,plan);unchanged();
    const saved={sponsored:prepared.body,lastValidBlockHeight:prepared.lastValidBlockHeight};
    storage.setItem(storageKey,JSON.stringify(saved));receipt=saved;phase='confirming';notify();
    let response;
    try{response=await api.sendSessionEntry(prepared.body);}
    catch(error){if(error.notSubmitted===true){storage.removeItem(storageKey);if(version===revision)receipt=null;}throw error;}
    saved.signature=response.signature;storage.setItem(storageKey,JSON.stringify(saved));unchanged(true);
    // The sponsor already waits for confirmation. Independently read the exact
    // successful confirmed transaction instead of starting a second subscription.
    await api.verifySessionReceipt(connection,prepared.body,response.signature);unchanged(true);
    storage.removeItem(storageKey);receipt=null;acceptedEntry={signature:response.signature,player:who,request:new PublicKey(plan.summary.request),count:batchCount};await refresh();unchanged(true);return {signature:response.signature,result:null};
   }
   let grantSession=null;
   if(action==='spin'&&!config.batchSpins&&(before.playerState?.prepaid??0n)/before.state.entry+BigInt(purchaseCount)>1n)grantSession=sessions.create(who.toBase58()).publicKey;
   const plan=cached?.plan??(action==='spin'?await api.planDevnetSpin(connection,config,who,'commit',undefined,{purchaseCount,grantSession,batchCount,allowOracleProbe:true}):['commit','settle'].includes(action)?await api.planDevnetSpin(connection,config,who,action):await api.planGameAction(connection,config,who,action,count));
   unchanged();let result=null;
   if(action==='settle' && before.state.pending?.player.equals(who) && (before.state.pending.count??1)===1) {
    if(plan.summary.acceptedNonce!==String(before.state.pending.nonce)||plan.summary.committedSeedSlot!==String(before.state.seedSlot))throw Error('Pending spin changed; refresh first');
    const reveal=plan.ixs.find(ix=>ix.programId.toBase58()===config.gameProgram&&ix.data[0]===15);
    let value;
    if(reveal){if(reveal.data.length!==98)throw Error('Unexpected reveal payload');value=reveal.data.subarray(-32);}
    else {const info=await connection.getAccountInfo(before.state.pending.request);const r=decodeRandomness(info,new PublicKey(config.oracleProgram));if(r.seedSlot!==before.state.seedSlot||r.revealSlot<=r.seedSlot)throw Error('Result does not match the accepted spin');value=info.data.subarray(152,184);}
    result=spinPresentation(value,before.state.pending,before.state);
   }
   const prepared=cached?.prepared??await api.prepareDevnetTransaction(connection,who,plan.ixs);unchanged();
   if(!await review({action,count,baseFeeLamports:prepared.baseFeeLamports,summary:plan.summary}))return {cancelled:true};
   unchanged();phase='wallet';notify();
   const guarded=action==='spin'?{get publicKey(){return chosen.publicKey;},signTransaction:async tx=>{unchanged();const signed=await chosen.signTransaction(tx);unchanged();return signed;}}:chosen;
   const signature=await api.signAndSendDevnet(connection,guarded,prepared,who,s=>{
    const saved={signature:s,lastValidBlockHeight:prepared.latest.lastValidBlockHeight};
    storage.setItem(storageKey,JSON.stringify(saved));if(version===revision){receipt=saved;phase='confirming';notify();}
   },()=>unchanged());
   unchanged(true);storage.removeItem(storageKey);receipt=null;
   if(action==='spin')acceptedEntry={signature,player:who,request:new PublicKey(plan.summary.request),count:batchCount};
   if(action==='refund')sessions.clear(who.toBase58());
   const after=await refresh();unchanged(true);
   if(action==='settle' && before.state.pending?.player.equals(who) && after.playerState?.receipt?.nonce===before.state.pending.nonce){const results=receiptResults(after.playerState.receipt,after.state);return {signature,results,result:results.length===1?results[0]:null};}
   return {signature,result};
  }finally{busy=false;phase='idle';notify();}
 }
 async function finishSpin(){
  if(busy)throw Error('Wait for the current action');
  if(receipt)throw Error('Check the submitted entry before revealing');
  if(!provider?.publicKey)throw Error('Connect the wallet that started this spin');
  const version=revision,who=provider.publicKey,expected=acceptedEntry;busy=true;phase='revealing';notify();
  const unchanged=()=>{if(version!==revision||!provider?.publicKey?.equals(who))throw Error('Wallet changed. Reconnect to see your result.');};
  try{
   const [before,seedSlot]=await Promise.all([api.readPlayerSnapshot(connection,config,who),expected?api.readCommitSeedSlot(connection,expected.signature,config.oracleProgram):null]);unchanged();
   const p=before.state.pending;
   if(expected){
    const saved=before.playerState?.receipt;
    if(!expected.player.equals(who))throw Error('Accepted spin belongs to another wallet');
    // A recovery worker can settle before our first read. The program-owned
    // receipt is usable only when its seed identifies THIS confirmed commit.
    // Its nonce and locked pot then come from that authenticated receipt.
    if(saved&&saved.seedSlot===seedSlot&&saved.request.equals(expected.request)&&saved.requested===expected.count){
     const results=receiptResults(saved,before.state);snapshot=before;acceptedEntry=null;notify();
     return {settled:true,results,requested:saved.requested,result:results.length===1?results[0]:null};
    }
    if(!p||!p.player.equals(who)||!p.request.equals(expected.request)||before.state.seedSlot!==seedSlot||(p.count??1)!==expected.count)throw Error('Waiting for the receipt of your accepted spin. Retry checking this same spin.');
   }
   if(!p||!p.player.equals(who))throw Error('This wallet has no accepted spin to finish');
   const ref={player:who.toBase58(),nonce:String(p.nonce),request:p.request.toBase58(),seedSlot:String(before.state.seedSlot)};
   let serviceError;
   try{await api.finishDevnetSpin(ref);}catch(error){serviceError=error;}
   unchanged();const after=await refresh();unchanged();
   if(after.state.pending?.nonce===p.nonce)throw serviceError??Error('The accepted result is still confirming. Retry the same result.');
   const receipt=after.playerState?.receipt;
   if(receipt && receipt.nonce===p.nonce && receipt.seedSlot===BigInt(ref.seedSlot) && receipt.request.equals(p.request) && receipt.requested===(p.count??1) && receipt.lockedPot===p.lockedPot){
    const results=receiptResults(receipt,snapshot.state);acceptedEntry=null;return {settled:true,results,requested:receipt.requested,result:results.length===1?results[0]:null};
   }
   if((p.count??1)>1)throw Error('Waiting for the confirmed pack receipt; your rewards remain on chain');
   if(after.state.nextNonce!==p.nonce+1n||after.state.seedSlot!==BigInt(ref.seedSlot))return {settled:true,result:null};
   const info=await connection.getAccountInfo(p.request,'confirmed'),random=decodeRandomness(info,new PublicKey(config.oracleProgram));unchanged();
   if(!random.authority.equals(before.game)||!random.queue.equals(before.state.queue)||random.seedSlot!==BigInt(ref.seedSlot)||random.revealSlot<=random.seedSlot||random.revealSlot>BigInt(after.slot))throw Error('Wait for the authenticated result to confirm');
   acceptedEntry=null;return {settled:true,result:spinPresentation(info.data.subarray(152,184),p,snapshot.state)};
  }finally{busy=false;phase='idle';notify();}
 }
 return {view,refresh,setWallet,warmSpin,cancelWarmup:invalidateWarm,act,checkReceipt,finishSpin};
}
