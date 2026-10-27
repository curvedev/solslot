// Exact co-signing only: the browser must already sign with the on-chain,
// bounded play key. This module never receives that key's private bytes.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {PublicKey,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
import {validateSpinDraft,encodeInstruction} from './devnet-spin.js';
const need=(ok,message)=>{if(!ok)throw Error(message);};
export function sessionRequest(body){
 need(body&&Object.keys(body).sort().join(',')==='lastValidBlockHeight,nonce,player,transaction'&&/^\d{1,20}$/.test(body.nonce)&&Number.isSafeInteger(body.lastValidBlockHeight)&&body.lastValidBlockHeight>0&&typeof body.transaction==='string'&&body.transaction.length<1800,'Invalid prepaid spin request');
 const player=new PublicKey(body.player),bytes=Buffer.from(body.transaction,'base64');
 need(bytes.toString('base64')===body.transaction&&bytes.length<=1232,'Invalid prepaid transaction encoding');
 return {player,id:'entry:'+createHash('sha256').update(JSON.stringify(body)).digest('hex'),tx:VersionedTransaction.deserialize(bytes)};
}
export async function validateSessionEntry(connection,config,payer,body,tx){
 const message=tx.message;
 need(message.version===0&&message.addressTableLookups.length===0&&message.header.numRequiredSignatures===2&&message.staticAccountKeys[0].equals(payer),'Unexpected prepaid transaction signers');
 need(tx.signatures[0].every(b=>b===0),'Send only the player session signature');
 const actor=message.staticAccountKeys[1],owner=new PublicKey(body.player);
 need(!actor.equals(owner)&&!actor.equals(payer),'Use a separate bounded play key');
 const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),actor.toBuffer()]),format:'der',type:'spki'});
 need(verify(null,message.serialize(),publicKey,tx.signatures[1]),'Missing valid play session signature');
 const ixs=TransactionMessage.decompile(message).instructions;
 need(ixs.length===2&&ixs[1].keys[0]?.pubkey.equals(actor),'Only a prepaid entry can be sponsored');
 const wire=ixs.map(encodeInstruction);
 // Account writability is compiled globally; the fee payer is never an entry
 // account, and the session signer is read-only in the instruction itself.
 wire[1].keys[0]={pubkey:owner.toBase58(),isWritable:false,isSigner:true};
 const plan=await validateSpinDraft(connection,config,owner,'commit',wire,{sessionActor:actor,batchCount:ixs[1].data[0]===17?ixs[1].data[1]:1});
 need(String(plan.snapshot.state.nextNonce)===body.nonce,'Game advanced; refresh before preparing another entry');
 const expected=new TransactionMessage({payerKey:payer,recentBlockhash:message.recentBlockhash,instructions:plan.ixs}).compileToV0Message();
 need(Buffer.from(expected.serialize()).equals(Buffer.from(message.serialize())),'Prepaid transaction changed the exact entry');
 need((await connection.isBlockhashValid(message.recentBlockhash,{commitment:'confirmed'})).value,'Prepaid transaction expired before submission');
 return plan;
}
