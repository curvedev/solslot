// A dedicated health request never supplies randomness for a player's pack.
import {randomBytes} from 'node:crypto';
import {PublicKey,ComputeBudgetProgram} from '@solana/web3.js';
import bs58 from 'bs58';
import {ORAO_PROGRAM,ORAO_NETWORK,ORAO_FULFILL_DISC,oraoRequestAddress,oraoRequestInstruction,decodeOraoNetwork,decodeOraoRequest} from './orao-vrf.js';
export const ORAO_PROBE_PREFIX='oracle-health:';
export const ORAO_PROBE_LIMIT=5000000,ORAO_PROBE_MAX_COUNT=3;
const need=(ok,m)=>{if(!ok)throw Error(m)};
export function probeSeed(attempt){need(typeof attempt?.id==='string'&&/^oracle-health:[a-f0-9]{64}$/.test(attempt.id),'Invalid oracle health request');return Buffer.from(attempt.id.slice(ORAO_PROBE_PREFIX.length),'hex');}
export function probeEnabled(config){return config.oraoProbe?.enabled===true&&config.oracleProgram===ORAO_PROGRAM.toBase58()&&config.queue===ORAO_NETWORK.toBase58();}
export async function draftOraoProbe(connection,config,payer){
 need(probeEnabled(config)&&new PublicKey(payer).toBase58()===config.automation,'Unreviewed oracle health payer');
 const network=decodeOraoNetwork(await connection.getAccountInfo(ORAO_NETWORK,'confirmed')),seed=randomBytes(32),request=oraoRequestAddress(seed);
 need(!await connection.getAccountInfo(request,'confirmed'),'Oracle health seed already exists');
 return {id:ORAO_PROBE_PREFIX+seed.toString('hex'),request,ixs:[ComputeBudgetProgram.setComputeUnitLimit({units:200000}),oraoRequestInstruction(payer,seed,network.treasury)]};
}
export async function readOraoProbe(connection,config,attempt){
 const seed=probeSeed(attempt),request=oraoRequestAddress(seed),info=await connection.getAccountInfo(request,'confirmed');
 if(!info)return {fulfilled:false,request};
 const result=decodeOraoRequest(request,info);need(result.client.toBase58()===config.automation&&result.seed.equals(seed),'Oracle health request belongs to another client');
 return {fulfilled:result.fulfilled,request};
}
export async function verifiedProbeRefund(connection,config,attempt,request){
 // Credit only a finalized rent shrink from this exact request to its client.
 // Ordinary transfers, payer fees and unrelated gifts never reduce gas spend.
 const client=new PublicKey(config.automation),rows=await connection.getSignaturesForAddress(request,{limit:12},'finalized');
 for(const row of rows){
  if(row.err)continue;
  const tx=await connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(!tx?.meta||tx.meta.err||tx.transaction.signatures?.[0]!==row.signature)continue;
  const message=tx.transaction.message,keys=message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses}),all=[...(message.compiledInstructions??message.instructions),...(tx.meta.innerInstructions??[]).flatMap(x=>x.instructions)];
  for(const ix of all){
   if(!keys.get(ix.programIdIndex)?.equals(ORAO_PROGRAM))continue;
   const data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data),indexes=ix.accountKeyIndexes??ix.accounts;
   if(!data.subarray(0,8).equals(ORAO_FULFILL_DISC)||!keys.get(indexes[3])?.equals(request)||!keys.get(indexes[4])?.equals(client)||indexes[4]===0)continue;
   const from=tx.meta.preBalances[indexes[3]]-tx.meta.postBalances[indexes[3]],received=tx.meta.postBalances[indexes[4]]-tx.meta.preBalances[indexes[4]];
   if(Number.isSafeInteger(from)&&from>0&&from===received&&from<=(attempt.spentLamports??0))return {lamports:from,signature:row.signature};
  }
 }
 return null;
}
