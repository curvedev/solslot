import {PublicKey,SystemProgram,TransactionInstruction} from '@solana/web3.js';
const U64_MAX=18446744073709551615n;
const need=(ok,message)=>{if(!ok)throw Error(message);};
export function publicKey(value, label = 'address') {
  let key; try { key = new PublicKey(value); } catch { throw new Error(`Invalid Solana ${label}`); }
  need(!key.equals(SystemProgram.programId), `${label} cannot be the system program`); return key;
}
export function validateRoles(config) {
  const roles=Object.fromEntries(['owner','treasury','automation'].map(k=>[k,publicKey(config[k],k)]));
  need(new Set(Object.values(roles).map(k=>k.toBase58())).size===3,'Use separate owner, treasury, and automation wallets');
  need(Object.values(roles).every(k=>PublicKey.isOnCurve(k.toBytes())),'Wallet roles must be signable addresses');
  need(config.quoteAsset==='SOL' && config.launchMode==='pumpfun','Expected SOL-paired pump.fun launch');
  need(config.jackpotShareBps===9000 && config.treasuryShareBps===1000,'Expected 90/10 net collected fee split');
  need(config.executionEnabled===false,'Execution is disabled in the development build'); return roles;
}
export function deriveGameAddresses(mint, gameProgram) {
  const [game]=PublicKey.findProgramAddressSync([Buffer.from('game'),mint.toBuffer()],gameProgram);
  return {game}; // The game account itself holds SOL plus its rent reserve.
}
export function splitCollectedFees(lamports) {
  need(typeof lamports==='bigint' && lamports>=0n && lamports<=U64_MAX,'Fees must be a nonnegative u64 lamport amount');
  const jackpot=lamports*9n/10n; return {jackpot,treasury:lamports-jackpot};
}
export function gameInstruction(programId,tag,keys,payload=Buffer.alloc(0)) {
  return new TransactionInstruction({programId:publicKey(programId),keys,data:Buffer.concat([Buffer.from([tag]),payload])});
}

