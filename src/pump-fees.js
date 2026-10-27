// Unsigned fee-account plans, rehearsed against locally cloned deployed Pump
// programs. Production signer/network admission is a separate, disabled path.
import {PublicKey, SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, createInitializeAccount3Instruction, createApproveInstruction, createRevokeInstruction, createCloseAccountInstruction, unpackAccount} from '@solana/spl-token';
import {deriveGameAddresses, gameInstruction, publicKey} from './launch-common.js';
import {PUMP_SDK,canonicalPumpPoolPda} from '@pump-fun/pump-sdk';
const need=(ok,message)=>{if(!ok)throw Error(message);};
const meta=(pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
export async function draftPumpShareUpdate(owner,mint,feeAccount,graduated=false){
 const ix=await PUMP_SDK.updateFeeSharesV2({authority:owner,mint,currentShareholders:[owner],newShareholders:[{address:feeAccount,shareBps:10000}],quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID});
 // The deployed program consumes the canonical pool after shareholders when
 // graduated. SDK 2.0.0 omits that remaining account. Keep the known layout strict.
 need(ix.keys.length===20&&ix.keys[19].pubkey.equals(owner),'Pump share interface changed; review before signing');
 if(graduated)ix.keys.push(meta(canonicalPumpPoolPda(mint)));
 return ix;
}
export async function pumpFeeAccount(owner,mint) {
  owner=publicKey(owner);mint=publicKey(mint);
  need(PublicKey.isOnCurve(owner.toBytes()),'Fee-account owner must be a wallet');
  const seed=mint.toBase58().slice(0,32);
  return {seed,address:await PublicKey.createWithSeed(owner,seed,TOKEN_PROGRAM_ID)};
}
export function verifyOwnedFeeAccount(address,info,owner) {
  need(info?.owner.equals(TOKEN_PROGRAM_ID),'Fee account must use legacy SPL Token');
  const token=unpackAccount(address,info,TOKEN_PROGRAM_ID);
  need(info.data.length===ACCOUNT_SIZE && token.mint.equals(NATIVE_MINT) && token.owner.equals(owner) && token.isNative && !token.isFrozen && token.closeAuthority===null,'Unexpected fee account identity or permissions');
  return token;
}
export async function draftFeeAccountSetup(connection,config,{delegate=true}={}) {
  const owner=publicKey(config.owner),mint=publicKey(config.mint),{seed,address}=await pumpFeeAccount(owner,mint);
  const info=await connection.getAccountInfo(address,'confirmed'),ixs=[];
  if(info?.owner.equals(TOKEN_PROGRAM_ID)) verifyOwnedFeeAccount(address,info,owner);
  else {
    need(!info||(info.owner.equals(SystemProgram.programId)&&info.data.length===0),'Unexpected pre-existing fee account');
    const rent=await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE),balance=info?.lamports??0;
    if(balance===0) ixs.push(SystemProgram.createAccountWithSeed({fromPubkey:owner,newAccountPubkey:address,basePubkey:owner,seed,space:ACCOUNT_SIZE,lamports:rent,programId:TOKEN_PROGRAM_ID}));
    else {
      if(balance<rent)ixs.push(SystemProgram.transfer({fromPubkey:owner,toPubkey:address,lamports:rent-balance}));
      ixs.push(SystemProgram.allocate({accountPubkey:address,basePubkey:owner,seed,space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}));
      ixs.push(SystemProgram.assign({accountPubkey:address,basePubkey:owner,seed,programId:TOKEN_PROGRAM_ID}));
    }
    ixs.push(createInitializeAccount3Instruction(address,NATIVE_MINT,owner,TOKEN_PROGRAM_ID));
  }
  if(delegate){const {game}=deriveGameAddresses(mint,publicKey(config.gameProgram));ixs.push(createApproveInstruction(address,game,owner,18446744073709551615n,[],TOKEN_PROGRAM_ID));}
  return {address,ixs,unsigned:true};
}
export async function draftFeeIngestion(config,payer) {
  const owner=publicKey(config.owner),mint=publicKey(config.mint),program=publicKey(config.gameProgram),treasury=publicKey(config.treasury),{game}=deriveGameAddresses(mint,program);
  need(!owner.equals(treasury),'Owner and treasury must differ');
  const {address}=await pumpFeeAccount(owner,mint),[temporary]=PublicKey.findProgramAddressSync([Buffer.from('fee-crank'),game.toBuffer()],program);
  return gameInstruction(program,18,[meta(publicKey(payer),true,true),meta(game),meta(address),meta(temporary),meta(NATIVE_MINT,false),meta(treasury),meta(owner),meta(SystemProgram.programId,false),meta(TOKEN_PROGRAM_ID,false)]);
}
export async function draftOwnedFeeAccountClose(connection,config) {
  const owner=publicKey(config.owner),{address}=await pumpFeeAccount(owner,config.mint);
  const token=verifyOwnedFeeAccount(address,await connection.getAccountInfo(address,'confirmed'),owner);
  return [...(token.delegate?[createRevokeInstruction(address,owner,[],TOKEN_PROGRAM_ID)]:[]),createCloseAccountInstruction(address,owner,owner,[],TOKEN_PROGRAM_ID)];
}
