// A saved DEV signature is a fixed capability, never a general-purpose signer.
// Call only under the production process lock, with a durable private save().
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {verifyFutureFeeApproval} from './prelaunch-fees.js';

const need=(ok,message)=>{if(!ok)throw Error(message)};
const terminal=new Set(['confirmed','failed']);

export async function createPrelaunchFeeBroadcaster({config,connection,approvals,ledger,save,assertReady,now=Date.now}){
 need(config.prelaunch?.enabled===true&&typeof assertReady==='function'&&typeof save==='function','Reviewed prelaunch setup is required');
 need(approvals?.version===1&&approvals.mint===config.mint&&approvals.owner===config.owner&&Array.isArray(approvals.approvals)&&approvals.approvals.length===2,'Launch permissions do not match the pinned release');
 const checked=[];
 for(let i=0;i<2;i++){
  const record=approvals.approvals[i];need(record.graduated===Boolean(i),'Expected separate curve and graduated permissions');
  checked.push(await verifyFutureFeeApproval(config,record));
 }
 need(ledger?.version===1&&ledger.mint===config.mint&&ledger.owner===config.owner&&ledger.gameProgram===config.gameProgram&&Array.isArray(ledger.attempts)&&ledger.attempts.length<=2,'Launch expense ledger identity mismatch');
 const ids=new Set();
 for(const a of ledger.attempts){
  need(typeof a.graduated==='boolean'&&!ids.has(a.graduated),'Duplicate launch fee attempt');ids.add(a.graduated);
  const draft=checked[Number(a.graduated)];
  need(a.signature===bs58.encode(draft.tx.signatures[0])&&a.nonce===draft.nonce&&a.nonceValue===draft.nonceValue,'Saved launch receipt differs from the approved transaction');
  need(['submitted','confirmed','failed'].includes(a.status)&&Number.isSafeInteger(a.broadcasts)&&a.broadcasts>=1&&a.broadcasts<=3&&Number.isSafeInteger(a.lastBroadcastAt)&&a.lastBroadcastAt>=0,'Invalid launch receipt state');
  need(a.reservedLamports===draft.maximumDebitLamports&&(!terminal.has(a.status)||(Number.isSafeInteger(a.spentLamports)&&a.spentLamports>=0&&a.spentLamports<=a.reservedLamports)),'Invalid launch expense history');
 }
 const owner=new PublicKey(config.owner);
 let active=null;
 const used=()=>ledger.attempts.reduce((sum,a)=>sum+(a.spentLamports??a.reservedLamports),0);
 async function reconcile(a){
  if(terminal.has(a.status))return a.status;
  const tx=await connection.getTransaction(a.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(!tx)return 'pending';
  const draft=checked[Number(a.graduated)],message=tx.transaction.message;
  need(Buffer.from(message.serialize()).equals(Buffer.from(draft.tx.message.serialize()))&&tx.transaction.signatures[0]===a.signature&&tx.meta,'Unexpected launch transaction receipt');
  const index=message.staticAccountKeys.findIndex(k=>k.equals(owner));need(index===0,'Unexpected launch fee payer');
  const spent=tx.meta.preBalances[index]-tx.meta.postBalances[index];
  need(Number.isSafeInteger(spent)&&spent>=0&&spent<=a.reservedLamports,'Launch debit exceeds its saved limit');
  Object.assign(a,{spentLamports:spent,status:tx.meta.err?'failed':'confirmed'});await save(ledger);return a.status;
 }
 async function broadcast(graduated){
  need(typeof graduated==='boolean','Expected an explicit launch phase');
  await assertReady(graduated);
  // An uncertain receipt must resolve before the independent fallback is used.
  // A finalized failed curve receipt may consume its nonce; the other one remains valid.
  for(const old of ledger.attempts)if(!terminal.has(old.status)&&await reconcile(old)==='pending'&&old.graduated!==graduated)return {state:'confirming-fees'};
  const draft=checked[Number(graduated)];let attempt=ledger.attempts.find(a=>a.graduated===graduated);
  if(attempt){const status=await reconcile(attempt);if(terminal.has(status))return {state:status==='confirmed'?'fees-confirmed':'fee-approval-failed'};}
  const nonce=await connection.getNonce(new PublicKey(draft.nonce),'finalized');
  need(nonce?.authorizedPubkey.equals(owner),'Launch nonce authority changed');
  if(nonce.nonce!==draft.nonceValue){
   // Never treat nonce consumption as failure: it can precede receipt availability.
   if(attempt)return {state:'confirming-fees'};
   throw Error('Launch permission was cancelled or used; reconcile it before continuing');
  }
  if(attempt&&(attempt.broadcasts>=3||now()-attempt.lastBroadcastAt<15000))return {state:'confirming-fees'};
  const before=await connection.getBalance(owner,'confirmed');
  const simulation=await connection.simulateTransaction(draft.tx,{sigVerify:true,commitment:'confirmed',accounts:{encoding:'base64',addresses:[config.owner]}});
  const after=simulation.value.accounts?.[0]?.lamports,debit=before-after;
  need(!simulation.value.err&&Number.isSafeInteger(after)&&Number.isSafeInteger(debit)&&debit>=0&&debit<=draft.maximumDebitLamports,'Future fee setup failed its current simulation or expense limit');
  const fee=(await connection.getFeeForMessage(draft.tx.message,'confirmed')).value;
  need(Number.isSafeInteger(fee)&&fee>=0&&fee<=100000,'Unexpected launch network fee');
  if(!attempt){
   need(used()+draft.maximumDebitLamports<=60000000,'Launch expense allowance exhausted');
   attempt={graduated,signature:bs58.encode(draft.tx.signatures[0]),nonce:draft.nonce,nonceValue:draft.nonceValue,status:'submitted',reservedLamports:draft.maximumDebitLamports,broadcasts:0,lastBroadcastAt:0};ledger.attempts.push(attempt);
  }
  attempt.broadcasts++;attempt.lastBroadcastAt=now();
  await save(ledger); // A failed save must prevent transmission.
  try{
   const signature=await connection.sendRawTransaction(draft.tx.serialize(),{preflightCommitment:'confirmed',maxRetries:0});
   need(signature===attempt.signature,'RPC returned a different launch signature');
  }catch{
   // The fixed signature remains the only transaction that may be resubmitted.
   // A timeout or simulation error is not evidence that the nonce is unused.
  }
  const status=await reconcile(attempt);
  return {state:status==='confirmed'?'fees-confirmed':status==='failed'?'fee-approval-failed':'confirming-fees'};
 }
 return {
  // Coalesce calls so the curve and fallback cannot be broadcast concurrently.
  send(graduated){if(active)return active;active=broadcast(graduated).finally(()=>{active=null});return active;},
  async reconcile(){for(const a of ledger.attempts)await reconcile(a);return {pending:ledger.attempts.some(a=>!terminal.has(a.status)),spentLamports:used()};},
 };
}
