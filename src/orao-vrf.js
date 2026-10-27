// Reviewed ORAO v0.4 RequestV2 interface. No signer or network is selected here.
import {Buffer} from 'buffer';
import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
export const ORAO_PROGRAM=new PublicKey('VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y');
export const ORAO_NETWORK=PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-network-configuration')],ORAO_PROGRAM)[0];
export const ORAO_REQUEST_RENT_BYTES=749,ORAO_RESULT_BYTES=137,ORAO_MAX_FEE=500000n;
export const ORAO_REQUEST_DISC=Buffer.from([38,151,209,6,195,102,28,217]);
export const ORAO_RESULT_DISC=Buffer.from([139,239,184,215,227,86,191,226]);
export const ORAO_NETWORK_DISC=Buffer.from([212,237,148,56,97,245,51,169]);
export const ORAO_FULFILL_DISC=Buffer.from([164,227,237,84,112,111,147,196]);
const need=(ok,message)=>{if(!ok)throw Error(message)};
export const oraoRequestAddress=seed=>{need(seed.length===32,'A 32-byte request seed is required');return PublicKey.findProgramAddressSync([Buffer.from('orao-vrf-randomness-request'),Buffer.from(seed)],ORAO_PROGRAM)[0]};
export function decodeOraoNetwork(info){
 need(info?.owner.equals(ORAO_PROGRAM),'Unexpected ORAO network owner');const d=Buffer.from(info.data);
 need(d.length>=85&&d.subarray(0,8).equals(ORAO_NETWORK_DISC),'Unexpected ORAO network layout');
 const n=d.readUInt32LE(80);need(n>=3&&n<=10&&d.length>=85+n*32,'Invalid ORAO quorum');
 const authorities=Array.from({length:n},(_,i)=>new PublicKey(d.subarray(84+i*32,116+i*32)));
 need(new Set(authorities.map(x=>x.toBase58())).size===n,'Duplicate ORAO fulfillers');
 const fee=d.readBigUInt64LE(72);need(fee<=ORAO_MAX_FEE,'ORAO fee exceeds the reviewed limit');
 return {authority:new PublicKey(d.subarray(8,40)),treasury:new PublicKey(d.subarray(40,72)),fee,authorities};
}
export function decodeOraoRequest(address,info){
 need(info?.owner.equals(ORAO_PROGRAM),'Unexpected randomness owner');const d=Buffer.from(info.data);
 need(d.length>=73&&d.subarray(0,8).equals(ORAO_RESULT_DISC)&&[0,1].includes(d[8]),'Unexpected ORAO request layout');
 const client=new PublicKey(d.subarray(9,41)),seed=d.subarray(41,73),fulfilled=d[8]===1;
 need(oraoRequestAddress(seed).equals(new PublicKey(address)),'Randomness request address mismatch');
 if(fulfilled)need(d.length===137,'Invalid fulfilled randomness size');
 else {need(d.length>=77,'Incomplete pending request');const n=d.readUInt32LE(73);need(n<=7&&d.length>=77+n*96,'Invalid pending responses');}
 return {client,seed,fulfilled,value:fulfilled?d.subarray(73,137):null};
}
export function oraoRequestInstruction(payer,seed,treasury){
 return new TransactionInstruction({programId:ORAO_PROGRAM,keys:[
  {pubkey:new PublicKey(payer),isWritable:true,isSigner:true},
  {pubkey:ORAO_NETWORK,isWritable:true,isSigner:false},
  {pubkey:new PublicKey(treasury),isWritable:true,isSigner:false},
  {pubkey:oraoRequestAddress(seed),isWritable:true,isSigner:false},
  {pubkey:SystemProgram.programId,isWritable:false,isSigner:false}],
  data:Buffer.concat([ORAO_REQUEST_DISC,Buffer.from(seed)])});
}
