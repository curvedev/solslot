import {Buffer} from 'buffer';
import {PublicKey,SystemProgram,ComputeBudgetProgram} from '@solana/web3.js';
import {addresses,readGame,instruction} from './solana-game.js';
import {decodeInstruction,encodeInstruction} from './devnet-spin.js';
import {ORAO_PROGRAM,ORAO_NETWORK,decodeOraoNetwork,decodeOraoRequest,oraoRequestAddress} from './orao-vrf.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
const meta=(pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
const budget=()=>ComputeBudgetProgram.setComputeUnitLimit({units:1000000});
const same=(a,b)=>a.programId.equals(b.programId)&&a.data.equals(b.data)&&a.keys.length===b.keys.length&&a.keys.every((k,i)=>k.pubkey.equals(b.keys[i].pubkey)&&k.isWritable===b.keys[i].isWritable&&k.isSigner===b.keys[i].isSigner);
const commitIx=(a,who,seed,count,treasury)=>instruction(a.program,23,[meta(who,true,true),meta(a.game),meta(a.player),meta(oraoRequestAddress(seed)),meta(ORAO_NETWORK),meta(treasury),meta(SystemProgram.programId,false),meta(ORAO_PROGRAM,false)],Buffer.concat([Buffer.from([count]),seed]));
const settleIx=(a,s)=>instruction(a.program,4,[meta(a.game),meta(addresses({gameProgram:a.program.toBase58(),mint:a.mint.toBase58(),tokenProgram:a.tokenProgram.toBase58()},s.pending.player).player),meta(s.pending.request,false),meta(a.vault),meta(a.mint),meta(a.tokenProgram,false)]);
export async function draftOraoSpin(connection,config,wallet,action,count=1){
 const who=new PublicKey(wallet),a=await readGame(connection,config,who),s=a.state;
 need(s.oracleProgram.equals(ORAO_PROGRAM)&&s.queue.equals(ORAO_NETWORK),'Wrong randomness configuration');
 if(action==='commit'){
  need([1,5,10].includes(count)&&!s.closed&&!s.pending&&s.pot>0n,'Game is not ready for this pack');
  const network=decodeOraoNetwork(await connection.getAccountInfo(ORAO_NETWORK,'confirmed'));
  const seed=Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  need(!await connection.getAccountInfo(oraoRequestAddress(seed)),'Randomness seed already used');
  return [budget(),commitIx(a,who,seed,count,network.treasury)].map(encodeInstruction);
 }
 need(action==='settle'&&s.pending,'No accepted spin to settle');
 const result=decodeOraoRequest(s.pending.request,await connection.getAccountInfo(s.pending.request,'confirmed'));
 need(result.client.equals(s.pending.player)&&result.fulfilled,'The accepted pack is waiting for its exact randomness result');
 return [budget(),settleIx(a,s)].map(encodeInstruction);
}
// Treat the HTTP draft as untrusted. Exact accounts, bytes and fees are checked
// against chain state before the browser or bounded relayer can sign anything.
export async function validateOraoSpin(game,connection,config,wallet,action,wire,{purchaseCount=0,batchCount=1,sessionActor=null,grantSession=null}={}){
 game.publicConfig(config);need(!sessionActor&&!grantSession,'ORAO packs use their wallet approval');
 need(['commit','settle'].includes(action)&&[1,5,10].includes(batchCount)&&[0,1,5,10].includes(purchaseCount)&&(!purchaseCount||action==='commit'),'Invalid pack request');
 need(Array.isArray(wire)&&wire.length===2,'Unexpected randomness instructions');
 const ixs=wire.map(decodeInstruction);need(same(ixs[0],budget()),'Unexpected compute budget');
 const validationStartedAt=Date.now(),a=await game.readSnapshot(connection,config,wallet),s=a.state,who=new PublicKey(wallet);let request;
 need(s.oracleProgram.equals(ORAO_PROGRAM)&&s.queue.equals(ORAO_NETWORK),'Wrong on-chain randomness provider');
 if(action==='commit'){
  need(!s.closed&&!s.pending&&s.pot>0n&&(a.playerState?.prepaid??0n)+BigInt(purchaseCount)*s.entry>=s.entry*BigInt(batchCount),'An open funded pot and enough prepaid tokens are required');
  need(ixs[1].data.length===34&&ixs[1].data[0]===23&&ixs[1].data[1]===batchCount,'Unexpected ORAO entry');
  const seed=ixs[1].data.subarray(2),network=decodeOraoNetwork(await connection.getAccountInfo(ORAO_NETWORK,'confirmed'));request=oraoRequestAddress(seed);
  const prior=await connection.getAccountInfo(request,'confirmed');need(!prior||(prior.owner.equals(SystemProgram.programId)&&prior.data.length===0),'Never accept an already requested or known random result');
  need(same(ixs[1],commitIx(a,who,seed,batchCount,network.treasury)),'Randomness draft changed its accounts, fee recipient or permissions');
  if(purchaseCount){
   need(a.balance>=BigInt(purchaseCount)*s.entry&&(a.playerState?.prepaid??0n)<s.entry,'Use available credits or acquire enough SOLPOT');
   const buy=[];if(!a.playerState)buy.push(instruction(a.program,1,[meta(who,true,true),meta(a.game),meta(a.player),meta(SystemProgram.programId,false)]));
   const n=Buffer.alloc(8);n.writeBigUInt64LE(BigInt(purchaseCount));buy.push(instruction(a.program,2,[meta(who,true,true),meta(a.game),meta(a.player),meta(a.target),meta(a.vault),meta(a.mint,false),meta(a.tokenProgram,false)],n));ixs.splice(1,0,...buy);
  }
 }else{
  need(s.pending,'No accepted pack is pending');request=s.pending.request;
  const result=decodeOraoRequest(request,await connection.getAccountInfo(request,'confirmed'));
  need(result.fulfilled&&result.client.equals(s.pending.player),'Waiting for the original pack result');
  need(same(ixs[1],settleIx(a,s)),'Settlement draft changed the accepted request or recipients');
 }
 return {ixs,snapshot:a,validationStartedAt,summary:{action,purchaseCount,batchCount,network:'Solana mainnet — real SOL and SOLPOT',signer:who.toBase58(),game:a.game.toBase58(),mint:a.mint.toBase58(),request:request.toBase58(),acceptedNonce:s.pending?.nonce.toString()??null,committedSeedSlot:s.pending?s.seedSlot.toString():null,note:'One fresh ORAO request per pack. Results persist on chain; settlement never requests another draw.'}};
}
