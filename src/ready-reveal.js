// Build the reviewed Solana reveal CPI once the accepted seed slot is past.
// Gateway/Oracle are the pinned Switchboard SDK interfaces; proof verification
// remains in the deployed oracle. This does not select or commit a new draw.
import {PublicKey,SystemProgram,SYSVAR_SLOT_HASHES_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {Randomness,Oracle,Gateway} from '@switchboard-xyz/on-demand';
import bs58 from 'bs58';
import {DEVNET_GENESIS,publicDevnetConfig,readGame,instruction} from './solana-game.js';
import {acceptedProofContext} from './oracle-proof-store.js';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const meta=(pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
export async function readyReveal(program,config,payer,requestAddress,services={}){
 return readyConfiguredReveal(program,config,payer,requestAddress,services,{validateConfig:publicDevnetConfig,genesisHash:DEVNET_GENESIS});
}
export async function readyConfiguredReveal(program,config,payer,requestAddress,services={},policy){
 policy.validateConfig(config);
 need(program.programId.toBase58()===config.oracleProgram,'Oracle program changed');
 const c=program.provider.connection,request=new PublicKey(requestAddress),actor=new PublicKey(payer);
 const api={readGame,loadRandomness:()=>new Randomness(program,request).loadData(),loadOracle:node=>new Oracle(program,node).loadData(),fetchProof:(url,params)=>new Gateway(url).fetchRandomnessReveal(params),...services};
 const [game,data]=await Promise.all([api.readGame(c,config,actor),api.loadRandomness()]);
 const pending=game.state.pending,seed=BigInt(data.seedSlot.toString());
 need(pending?.request.equals(request)&&data.authority.equals(game.game)&&data.queue.equals(new PublicKey(config.queue))&&game.state.queue.equals(data.queue)&&game.state.seedSlot===seed,'Oracle result does not match the accepted spin');
 need(seed>0n&&BigInt(data.revealSlot.toString())<=seed,'The accepted request is already revealed or has no seed');
 const slot=await c.getSlot('confirmed');
 need(Number.isSafeInteger(slot)&&Number.isSafeInteger(Number(seed))&&BigInt(slot)>seed,'The accepted seed slot is not ready to reveal; keep this same spin');
 let context=null,proof;
 if(api.proofStore){
  const genesisHash=await c.getGenesisHash();
  need(genesisHash===policy.genesisHash,'The proof archive is restricted to this configured network');
  context=acceptedProofContext({genesisHash,gameProgram:game.program.toBase58(),game:game.game.toBase58(),player:pending.player.toBase58(),nonce:String(pending.nonce),request:request.toBase58(),queue:data.queue.toBase58(),oracle:data.oracle.toBase58(),seedSlot:String(seed),seedSlothash:bs58.encode(data.seedSlothash),activeSignerHex:Buffer.from(data.activeSecp256K1Signer??[]).toString('hex'),activeSignerExpiration:data.activeSecp256K1Expiration?.toString()});
  proof=api.proofStore.get(context)?.proof;
 }
 if(!proof){
  const oracle=await api.loadOracle(data.oracle),url=Buffer.from(oracle.gatewayUri).toString().replace(/\0+$/,'');
  proof=await api.fetchProof(url,{randomnessAccount:request,slothash:bs58.encode(data.seedSlothash),slot:Number(seed),rpc:c.rpcEndpoint});
 }
 const signature=Buffer.from(proof.signature??'','base64');
 need(signature.length===64&&signature.toString('base64')===proof.signature&&Number.isInteger(proof.recovery_id)&&proof.recovery_id>=0&&proof.recovery_id<=3&&Array.isArray(proof.value)&&proof.value.length===32&&proof.value.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'Malformed oracle proof; preserve the accepted spin');
 const oracleProgram=new PublicKey(config.oracleProgram),stats=PublicKey.findProgramAddressSync([Buffer.from('OracleRandomnessStats'),data.oracle.toBuffer()],oracleProgram)[0],state=PublicKey.findProgramAddressSync([Buffer.from('STATE')],oracleProgram)[0];
 const payload=Buffer.concat([signature,Buffer.from([proof.recovery_id]),Buffer.from(proof.value)]);
 // Drafting never persists an unverified gateway response. The private relayer
 // archives this exact candidate only after the complete reveal passes simulation.
 if(context&&api.onRevealProof)await api.onRevealProof({context,proof:{signature:proof.signature,recovery_id:proof.recovery_id,value:[...proof.value]}});
 return instruction(game.program,15,[meta(actor,true,true),meta(game.game),meta(oracleProgram,false),meta(request),meta(data.oracle,false),meta(data.queue,false),meta(stats),meta(game.game,false),meta(actor,true,true),meta(SYSVAR_SLOT_HASHES_PUBKEY,false),meta(SystemProgram.programId,false),meta(getAssociatedTokenAddressSync(NATIVE_MINT,request)),meta(TOKEN_PROGRAM_ID,false),meta(NATIVE_MINT,false),meta(state,false)],payload);
}
