// A tab-scoped key can only consume the player's explicitly granted prepaid
// allowance. It holds no SOL or tokens and cannot claim, buy, refund or administer.
import {Keypair,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
export function createPlaySessions(config,storage){
 const memory=new Map(),key=who=>`solpot:play-session:${config.gameProgram}:${config.mint}:${who}`;
 function load(who){
  const id=key(who);if(memory.has(id))return memory.get(id);
  try{const raw=storage?.getItem(id);if(!raw)return null;const bytes=JSON.parse(raw);if(!Array.isArray(bytes)||bytes.length!==64||!bytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255))return null;const pair=Keypair.fromSecretKey(new Uint8Array(bytes));memory.set(id,pair);return pair;}catch{return null;}
 }
 return {
  load,
  create(who){const pair=Keypair.generate(),id=key(who);memory.set(id,pair);try{storage?.setItem(id,JSON.stringify([...pair.secretKey]));}catch{}return pair;},
  clear(who){memory.delete(key(who));try{storage?.removeItem(key(who));}catch{}},
  ready(who,snapshot){const pair=load(who),p=snapshot?.playerState;return !!(pair&&p?.session?.equals(pair.publicKey)&&p.sessionSpins>0n&&p.sessionExpiry>=BigInt(snapshot.slot)&&p.prepaid>=snapshot.state.entry);}
 };
}
export async function prepareSessionEntry(connection,owner,payer,pair,plan){
 const latest=await connection.getLatestBlockhash('confirmed');
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(payer),recentBlockhash:latest.blockhash,instructions:plan.ixs}).compileToV0Message());
 if(tx.message.header.numRequiredSignatures!==2||!tx.message.staticAccountKeys[1].equals(pair.publicKey))throw Error('Unexpected play session signers');
 tx.sign([pair]);
 return {body:{player:new PublicKey(owner).toBase58(),nonce:String(plan.snapshot.state.nextNonce),lastValidBlockHeight:latest.lastValidBlockHeight,transaction:Buffer.from(tx.serialize()).toString('base64')},...latest};
}
export async function sendSessionEntry(body,fetcher=fetch){
 const response=await fetcher('/api/devnet/session-spin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
 const result=await response.json();
 if(!response.ok){const error=Error(result.error||'The prepaid spin is still checking. Check its saved transaction.');error.notSubmitted=result.notSubmitted===true;throw error;}
 return result;
}
export async function readSessionReceipt(body,fetcher=fetch){
 const response=await fetcher('/api/devnet/session-receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const result=await response.json();
 if(!response.ok)throw Error(result.error||'Unable to check the saved prepaid entry');
 return result;
}
export async function verifySessionReceipt(connection,body,signature,{requireSuccess=true}={}){
 const transaction=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
 if(!transaction)throw Error('Waiting for the prepaid transaction record. Check its saved receipt.');
 if(!transaction.meta||!('err' in transaction.meta)||(requireSuccess&&transaction.meta.err!==null)||!Number.isSafeInteger(transaction.slot))throw Error('Prepaid transaction did not confirm successfully. Check its saved receipt.');
 const expected=VersionedTransaction.deserialize(Buffer.from(body.transaction,'base64')).message.serialize();
 if(!Buffer.from(transaction.transaction.message.serialize()).equals(Buffer.from(expected)))throw Error('Prepaid receipt does not match the signed entry');
 return {slot:transaction.slot};
}
