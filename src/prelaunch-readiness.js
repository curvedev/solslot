// Read-only on-chain conditions for the reserved-to-live transition.
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {AnchorUtils,Randomness} from '@switchboard-xyz/on-demand';
import {feeSharingConfigPda} from '@pump-fun/pump-sdk';
import {createMainnetGameAdapter} from './mainnet-game.js';
import {addresses,decodeGame,instruction} from './solana-game.js';
import {verifyGameTokenAccount} from './solana-tokens.js';
import {inspectPump} from './solana-launch.js';
import {pumpFeeAccount,verifyOwnedFeeAccount} from './pump-fees.js';
import {ORAO_PROGRAM,ORAO_NETWORK,decodeOraoNetwork} from './orao-vrf.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
export function createPrelaunchInspection(connection,config){
 need(config.prelaunch?.enabled===true,'Prelaunch has not been reviewed');
 const pinned=structuredClone(config),game=createMainnetGameAdapter({...pinned,release:{...pinned.release,status:'verified',entriesEnabled:false}});
 const a=addresses(pinned,pinned.automation),sharing=feeSharingConfigPda(a.mint);let oracleProgram;
 return async()=>{
  await game.assertNetwork(connection,{fresh:false});
  const fee=await pumpFeeAccount(pinned.owner,pinned.mint);
  const [mintInfo,gameInfo,feeInfo,sharingInfo,vaultInfo]=await connection.getMultipleAccountsInfo([a.mint,a.game,fee.address,sharing,a.vault],'finalized');
  need(gameInfo?.owner.equals(a.program),'Prepared game is missing or has a different owner');
  const state=decodeGame(gameInfo.data);
  for(const name of ['owner','treasury','mint','oracleProgram','queue'])need(state[name].toBase58()===pinned[name],'Prepared game identity changed');
  if(state.closed)return {closed:true,mintExists:!!mintInfo,gameReady:state.launchReady};
  if(!state.launchReady)need(state.openPlayers===0n&&!state.pending&&state.prepaidLiability===0n&&state.solLiability===0n&&state.tokenLiability===0n,'Reservation contains player obligations');
  const orao=pinned.oracleProgram===ORAO_PROGRAM.toBase58();
  need(state.openOracles===(orao?0n:1n),'Unexpected reusable randomness accounts');
  const account=verifyOwnedFeeAccount(fee.address,feeInfo,new PublicKey(pinned.owner));
  const available=BigInt(feeInfo.lamports)-account.rentExemptReserve;
  need(account.delegate?.equals(a.game)&&account.delegatedAmount>0n&&account.delegatedAmount>=available&&(!state.launchReady?account.delegatedAmount===18446744073709551615n:true),'The dedicated fee delegation is missing or exhausted');
  if(orao){decodeOraoNetwork(await connection.getAccountInfo(ORAO_NETWORK,'confirmed'));}
  else {
   oracleProgram??=await AnchorUtils.loadProgramFromConnection(connection);
   need(oracleProgram.programId.toBase58()===pinned.oracleProgram,'Unexpected randomness program');
   const request=await new Randomness(oracleProgram,new PublicKey(pinned.randomness)).loadData();
   need(request.authority.equals(a.game)&&request.queue.toBase58()===pinned.queue,'Prepared randomness identity changed');
  }
  const mintExists=!!mintInfo&&!(mintInfo.owner.equals(SystemProgram.programId)&&mintInfo.data.length===0);
  if(!mintExists){need(!state.launchReady&&!sharingInfo,'Activated state exists without the pinned token');return {closed:false,mintExists:false,gameReady:false,feeSharesReady:false,potLamports:String(state.pot)};}
  const pump=await inspectPump(connection,{...pinned,pumpfun:{...pinned.pumpfun,sharingConfig:sharingInfo?sharing.toBase58():null}});
  if(state.launchReady){
   need(state.entry===BigInt(pinned.entryTokens??'200000')*1000000n&&state.consolation===BigInt(pinned.consolationTokens??'100000')*1000000n,'Activated game prices differ from the pinned release');
   const vault=verifyGameTokenAccount(a.vault,vaultInfo,a.mint,a.game,a.tokenProgram);
   need(vault.amount>=state.tokenLiability+state.prepaidLiability,'Token vault does not cover player obligations');
   const rent=BigInt(await connection.getMinimumBalanceForRentExemption(512));
   need(BigInt(gameInfo.lamports)>=rent+state.pot+state.solLiability+(state.pending?.lockedPot??0n),'Game SOL does not cover its pot and player obligations');
  }
  return {closed:false,mintExists:true,gameReady:state.launchReady,feeSharesReady:!!pump.sharing,graduated:!!pump.pool,potLamports:String(state.pot)};
 };
}
export async function draftPrelaunchActivation(connection,config){
 const state=await createPrelaunchInspection(connection,config)();
 need(!state.closed&&state.mintExists&&state.feeSharesReady&&!state.gameReady,'Activation requires a verified token, fixed fees and open reservation');
 const a=addresses(config,config.automation),payer=new PublicKey(config.automation);
 return [createAssociatedTokenAccountIdempotentInstruction(payer,a.vault,a.game,a.mint,TOKEN_2022_PROGRAM_ID),instruction(a.program,20,[{pubkey:a.game,isWritable:true,isSigner:false},{pubkey:a.mint,isWritable:false,isSigner:false}])];
}
