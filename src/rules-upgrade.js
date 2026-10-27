// DEV-authorized bytecode update, restricted to the still-unlaunched game.
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {addresses,decodeGame} from './solana-game.js';
import {draftPrelaunchUpgrade} from './prelaunch-upgrade.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
export async function inspectRulesReservation(connection,config){
 const a=addresses(config,config.owner),[mint,game]=await connection.getMultipleAccountsInfo([a.mint,a.game],'finalized');
 need(!mint||(mint.owner.equals(SystemProgram.programId)&&mint.data.length===0),'Token already launched; review the current state before changing rules');
 need(game?.owner.equals(a.program),'Reserved game is missing');const s=decodeGame(game.data);
 for(const name of ['owner','treasury','mint','oracleProgram','queue'])need(s[name].equals(new PublicKey(config[name])),'Reservation identities changed');
 need(!s.launchReady&&!s.closed&&s.openPlayers===0n&&s.openOracles===0n&&!s.pending&&s.nextNonce===1n&&s.burned===0n&&s.tokenLiability===0n&&s.solLiability===0n&&s.prepaidLiability===0n,'Rule update requires an unused reservation');
 return s;
}
export async function draftRulesUpgrade(connection,config,review,action,bufferSigner){
 need(review?.kind==='rules-50k-full-back'&&review.entryTokens==='50000'&&review.consolationTokens==='50000'&&review.localRehearsalPassed===true,'Missing reviewed 50,000-token entry-back update');
 await inspectRulesReservation(connection,config);
 return draftPrelaunchUpgrade(connection,config,review,action,bufferSigner);
}
