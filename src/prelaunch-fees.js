// Build fixed future fee-routing messages. Never signs, submits or reads a key.
import {PublicKey,SystemProgram,ComputeBudgetProgram,TransactionMessage,VersionedTransaction,NONCE_ACCOUNT_LENGTH} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {NATIVE_MINT,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {PUMP_SDK,canonicalPumpPoolPda} from '@pump-fun/pump-sdk';
import {PUMP_SDK as CURRENT_PUMP_SDK} from '@pump-fun/pump-sdk-current';
import {buildLaunchParameters} from './solana-launch.js';
import {pumpFeeAccount,draftPumpShareUpdate} from './pump-fees.js';
export async function launchNonceAddress(owner,mint,{graduated=false}={}){
 if(typeof graduated!=='boolean')throw Error('Invalid launch phase');
 const seed=(graduated?'solpot-armg-':'solpot-armc-')+new PublicKey(mint).toBase58().slice(0,20);
 return {seed,address:await PublicKey.createWithSeed(new PublicKey(owner),seed,SystemProgram.programId)};
}
export async function draftFutureFeeApproval(config,nonceValue,{graduated=false}={}){
 buildLaunchParameters(config);
 if(config.pumpfun.tokenCreation!=='owner-launcher'||config.pumpfun.externalMintConfirmed!==true||config.pumpfun.sharingConfig!==null)throw Error('Confirm the external mint before preparing fee permission');
 if(typeof graduated!=='boolean'||new PublicKey(nonceValue).toBase58()!==nonceValue)throw Error('Invalid future fee approval');
 const owner=new PublicKey(config.owner),mint=new PublicKey(config.mint),{address:nonce}=await launchNonceAddress(owner,mint,{graduated}),{address:fees}=await pumpFeeAccount(owner,mint);
 const sweepArgs={payer:owner,mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID};
 const sweeps=config.pumpfun.creatorFeeSweeps===true?[
  await CURRENT_PUMP_SDK.sweepCreatorFeeInstruction({...sweepArgs,creator:owner}),
  ...(graduated?[await CURRENT_PUMP_SDK.sweepPoolCreatorFeeInstruction({...sweepArgs,coinCreator:owner})]:[]),
 ]:[];
 const instructions=[SystemProgram.nonceAdvance({noncePubkey:nonce,authorizedPubkey:owner}),ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),...sweeps,
  await PUMP_SDK.createFeeSharingConfig({creator:owner,mint,pool:graduated?canonicalPumpPoolPda(mint):null}),
  await draftPumpShareUpdate(owner,mint,fees,graduated)];
 const tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:nonceValue,instructions}).compileToV0Message());
 if(tx.serialize().length>1232)throw Error('Future fee permission exceeds Solana transaction size');
 return {tx,nonce:nonce.toBase58(),nonceValue,feeAccount:fees.toBase58(),graduated,maximumDebitLamports:30000000};
}
export async function draftLaunchNonce(connection,config){
 const owner=new PublicKey(config.owner),ixs=[],addresses=[];
 for(const graduated of [false,true]){
  const n=await launchNonceAddress(owner,config.mint,{graduated});
  if(await connection.getAccountInfo(n.address,'confirmed'))throw Error('Launch nonce already exists; inspect it instead of funding it again');
  const rent=await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  addresses.push(n.address);ixs.push(SystemProgram.createAccountWithSeed({fromPubkey:owner,newAccountPubkey:n.address,basePubkey:owner,seed:n.seed,space:NONCE_ACCOUNT_LENGTH,lamports:rent,programId:SystemProgram.programId}),SystemProgram.nonceInitialize({noncePubkey:n.address,authorizedPubkey:owner}));
 }
 return {addresses,ixs};
}
// A signed future transaction is a capability. Rebuild every byte from the
// pinned release; reject extra instructions, altered destinations and signatures.
export async function verifyFutureFeeApproval(config,record){
 if(!record||Object.keys(record).sort().join(',')!=='graduated,nonceValue,transactionBase64'||typeof record.transactionBase64!=='string'||record.transactionBase64.length>1644)throw Error('Invalid saved fee permission');
 const draft=await draftFutureFeeApproval(config,record.nonceValue,{graduated:record.graduated});
 const bytes=Buffer.from(record.transactionBase64,'base64');
 if(bytes.toString('base64')!==record.transactionBase64)throw Error('Noncanonical fee permission encoding');
 const tx=VersionedTransaction.deserialize(bytes),message=tx.message.serialize();
 if(!Buffer.from(message).equals(Buffer.from(draft.tx.message.serialize()))||tx.signatures.length!==1||!ed25519.verify(tx.signatures[0],message,new PublicKey(config.owner).toBytes()))throw Error('Fee permission differs from its fixed DEV approval');
 return {...draft,tx};
}
