// Reservation inspection is separate from normal gameplay, which requires a mint.
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {addresses,decodeGame,instruction} from './solana-game.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
const meta=(pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
export async function readReservedGame(connection,config){
 const a=addresses(config,config.owner),info=await connection.getAccountInfo(a.game,'confirmed');
 need(info?.owner.equals(a.program),'Reserved game is missing or owned by a different program');
 const state=decodeGame(info.data);
 for(const name of ['owner','treasury','mint','oracleProgram','queue'])need(state[name].toBase58()===config[name],'Reserved game identity mismatch');
 need(!state.launchReady,'Game is already activated');
 need(state.openPlayers===0n&&!state.pending&&state.prepaidLiability===0n&&state.solLiability===0n&&state.tokenLiability===0n,'Reservation contains player obligations');
 return {...a,state};
}
export async function draftGameReservation(connection,config){
 need(config.pumpfun?.tokenCreation==='owner-launcher'&&config.pumpfun.externalMintConfirmed===true,'Confirm the owner-supplied CA before reservation');
 const a=addresses(config,config.owner),owner=new PublicKey(config.owner),[mint,game]=await connection.getMultipleAccountsInfo([a.mint,a.game],'confirmed');
 need(!game,'Game already exists; do not reserve twice');
 need(!mint||(mint.owner.equals(SystemProgram.programId)&&mint.data.length===0),'The token already exists; use normal initialization');
 const [pd]=PublicKey.findProgramAddressSync([a.program.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
 return instruction(a.program,19,[meta(owner,true,true),meta(a.game),meta(a.mint,false),meta(new PublicKey(config.treasury),false),meta(new PublicKey(config.oracleProgram),false),meta(new PublicKey(config.queue),false),meta(SystemProgram.programId,false),meta(pd,false)]);
}
