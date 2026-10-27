// SDK-assisted exact CPI drafts. These functions never sign or submit transactions.
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, ComputeBudgetProgram } from '@solana/web3.js';
import { Randomness, Queue } from '@switchboard-xyz/on-demand';
import { readyReveal } from './ready-reveal.js';
import { addresses, instruction, readGame } from './solana-game.js';
const layouts = {
  14: { name: 'randomnessInit', authority: 2, length: 13, discriminator: [9,9,204,33,50,116,113,15] },
  15: { name: 'randomnessReveal', authority: 4, length: 12, discriminator: [197,181,187,10,30,58,20,73] },
  16: { name: 'randomnessClose', authority: 2, length: 10, discriminator: [146,101,14,74,225,246,0,156] },
};
export function wrapOracleInstruction(config, actor, tag, oracleIx) {
  const a = addresses(config, actor), layout = layouts[tag], oracle = new PublicKey(config.oracleProgram);
  if (!layout || !oracleIx.programId.equals(oracle) || oracleIx.keys.length !== layout.length || !layout.discriminator.every((v,i)=>oracleIx.data[i]===v)) throw Error('Deployed oracle interface differs from the reviewed layout');
  const keys = oracleIx.keys.map(k=>({ ...k }));
  // Initialization selects the game PDA as authority; reveal/close already name it.
  if (tag === 14) keys[layout.authority].pubkey = a.game;
  if (!keys[layout.authority].pubkey.equals(a.game)) throw Error('Request is not controlled by this game');
  keys[layout.authority].isSigner = false; // The program signs only its exact CPI.
  return instruction(a.program, tag, [{pubkey:new PublicKey(actor),isWritable:true,isSigner:true},{pubkey:a.game,isWritable:true,isSigner:false},{pubkey:oracle,isWritable:false,isSigner:false},...keys], oracleIx.data.subarray(8));
}
export async function draftOracleInit(program, config, requestKeypair) {
  const [request, ix] = await Randomness.create(program, requestKeypair, new PublicKey(config.queue), new PublicKey(config.owner));
  return { request, instruction: wrapOracleInstruction(config, config.owner, 14, ix) };
}
export async function selectCommitOracle(program, config) {
  return (await new Queue(program, new PublicKey(config.queue)).selectRandomnessOracle()).oracle.pubkey;
}
export async function draftOracleReveal(program, config, payer, requestAddress, services = {}) {
  return readyReveal(program, config, payer, requestAddress, services);
}
export async function draftOracleClose(program, config, requestAddress) {
  return wrapOracleInstruction(config, config.owner, 16, await new Randomness(program, new PublicKey(requestAddress)).closeIx());
}
const meta = (pubkey,isWritable=true,isSigner=false)=>({pubkey,isWritable,isSigner});
export async function draftSpinCommit(program, connection, config, playerWallet, requestAddress, count = 1, services = {}) {
  if (!Number.isInteger(count) || count<1 || count>10 || (count>1 && !config.batchSpins)) throw Error('Invalid pack size');
  const a = await readGame(connection, config, playerWallet), s = a.state;
  if (s.closed || s.pending || s.pot === 0n) throw Error('Game is closed, busy, or has an empty pot');
  if (!s.oracleProgram.equals(program.programId) || !s.queue.equals(new PublicKey(config.queue))) throw Error('Oracle configuration mismatch');
  const request = new Randomness(program,new PublicKey(requestAddress)), data = await request.loadData();
  if (!data.authority.equals(a.game) || !data.queue.equals(s.queue)) throw Error('Request authority or queue mismatch');
  const node = await (services.selectOracle??selectCommitOracle)(program,config);
  return [ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),instruction(a.program,count>1?17:3,[meta(new PublicKey(playerWallet),false,true),meta(a.game),meta(a.player),meta(request.pubkey),meta(s.queue,false),meta(node),meta(SYSVAR_SLOT_HASHES_PUBKEY,false),meta(s.oracleProgram,false)],count>1?Buffer.from([count]):Buffer.alloc(0))];
}
export async function draftSpinSettlement(program, connection, config, payer, services = {}) {
  const a = await readGame(connection,config,payer), s = a.state;
  if (!s.pending || !s.oracleProgram.equals(program.programId) || !s.queue.equals(new PublicKey(config.queue))) throw Error('No matching oracle request is pending');
  const request = new Randomness(program,s.pending.request), data = await request.loadData();
  if (!data.authority.equals(a.game) || !data.queue.equals(s.queue) || BigInt(data.seedSlot.toString()) !== s.seedSlot) throw Error('Oracle result does not match the accepted spin');
  const player = addresses(config,s.pending.player).player;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({units:1000000})];
  if (BigInt(data.revealSlot.toString()) <= s.seedSlot) ixs.push(await (services.draftReveal??draftOracleReveal)(program,config,payer,s.pending.request,services));
  ixs.push(instruction(a.program,4,[meta(a.game),meta(player),meta(s.pending.request,false),meta(a.vault),meta(a.mint),meta(a.tokenProgram,false)]));
  return ixs; // Reveal and settlement share one transaction; retry never recommits.
}
