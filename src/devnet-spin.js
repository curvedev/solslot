import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { addresses, readPlayerSnapshot, publicDevnetConfig, instruction } from './solana-game.js';

const need = (ok, message) => { if (!ok) throw Error(message); };
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
export function encodeInstruction(ix) {
  return { programId: ix.programId.toBase58(), keys: ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })), data: Buffer.from(ix.data).toString('base64') };
}
export function decodeInstruction(value) {
  need(value && typeof value.data === 'string' && value.data.length <= 1024 && Array.isArray(value.keys) && value.keys.length <= 20, 'Malformed oracle instruction');
  return new TransactionInstruction({ programId: new PublicKey(value.programId), keys: value.keys.map(k => {
    need(typeof k.isWritable === 'boolean' && typeof k.isSigner === 'boolean', 'Malformed account permissions');
    return { pubkey: new PublicKey(k.pubkey), isWritable: k.isWritable, isSigner: k.isSigner };
  }), data: Buffer.from(value.data, 'base64') });
}
function checkKeys(ix, expected) {
  need(ix.keys.length === expected.length && ix.keys.every((k, i) => k.pubkey.equals(expected[i].pubkey) && k.isSigner === expected[i].isSigner && k.isWritable === expected[i].isWritable), 'Oracle draft changed the expected accounts or permissions');
}
export function decodeRandomness(info, oracle) {
  need(info?.owner.equals(oracle), 'Randomness account has the wrong program owner');
  const b = Buffer.from(info.data);
  need(b.length === 480 && b.subarray(0, 8).equals(Buffer.from([10,66,229,135,220,239,217,114])), 'Unexpected randomness account layout');
  return { authority: new PublicKey(b.subarray(8,40)), queue: new PublicKey(b.subarray(40,72)), seedSlot: b.readBigUInt64LE(104), oracle: new PublicKey(b.subarray(112,144)), revealSlot: b.readBigUInt64LE(144) };
}
// Validate the unsigned service response against fresh chain state. The service
// cannot add arbitrary transfers, programs, recipients, or wallet signers.
export async function validateSpinDraft(connection, config, wallet, action, wire, options = {}) {
 return validateConfiguredSpinDraft(connection,config,wallet,action,wire,options,{validateConfig:publicDevnetConfig,readSnapshot:readPlayerSnapshot,networkLabel:'Solana devnet — test funds',tokenLabel:'test SOLPOT'});
}
// Only trusted network adapters supply policy. Request JSON cannot select a
// validator or weaken the exact account/permission checks below.
export async function validateConfiguredSpinDraft(connection, config, wallet, action, wire, { purchaseCount = 0, sessionActor = null, grantSession = null, batchCount = 1 } = {}, policy) {
  const validationStartedAt=Date.now();
  policy.validateConfig(config);
  need(Number.isInteger(batchCount) && batchCount>=1 && batchCount<=10 && (batchCount===1 || (config.batchSpins && action==='commit')), 'Invalid pack size');
  need(['commit', 'settle'].includes(action), 'Unsupported spin action');
  need([0,1,5,10].includes(purchaseCount) && (!purchaseCount || action === 'commit'), 'Invalid prepaid purchase');
  need(!(sessionActor && (purchaseCount || grantSession)) && (!(sessionActor || grantSession) || action==='commit'), 'Invalid play session action');
  need(Array.isArray(wire) && wire.length >= 2 && wire.length <= 3, 'Unexpected spin instruction count');
  const ixs = wire.map(decodeInstruction), budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 });
  need(ixs[0].programId.equals(budget.programId) && ixs[0].data.equals(budget.data) && ixs[0].keys.length === 0, 'Unexpected compute budget');
  const a = await policy.readSnapshot(connection, config, wallet), s = a.state, who = new PublicKey(wallet);
  const oracle = new PublicKey(config.oracleProgram), request = action === 'commit' ? new PublicKey(config.randomness) : s.pending?.request;
  need(request, 'There is no pending spin to settle');
  const random = decodeRandomness(await connection.getAccountInfo(request, 'confirmed'), oracle);
  need(random.authority.equals(a.game) && random.queue.equals(s.queue), 'Randomness account belongs to another game');
  for (const ix of ixs.slice(1)) need(ix.programId.equals(a.program), 'Unexpected program in oracle draft');
  if (action === 'commit') {
    need(!s.closed && !s.pending && s.pot > 0n && (a.playerState?.prepaid ?? 0n) + BigInt(purchaseCount) * s.entry >= s.entry * BigInt(batchCount), 'Spin requires an open funded game and prepaid credit, with no pending result');
    need(ixs.length === 2 && ixs[1].data.equals(Buffer.from(batchCount>1?[17,batchCount]:[3])) && ixs[1].keys.length === 8, 'Unexpected commit payload');
    const node = ixs[1].keys[5].pubkey;
    need((await connection.getAccountInfo(node, 'confirmed'))?.owner.equals(oracle), 'Oracle node has the wrong owner');
    checkKeys(ixs[1], [meta(who,false,true),meta(a.game),meta(a.player),meta(request),meta(s.queue,false),meta(node),meta(SYSVAR_SLOT_HASHES_PUBKEY,false),meta(oracle,false)]);
    if(sessionActor){
      const actor=new PublicKey(sessionActor),p=a.playerState;
      need(p?.session.equals(actor) && !actor.equals(who) && p.sessionSpins>=BigInt(batchCount) && p.sessionExpiry>=BigInt(a.slot), 'Play session expired or no longer authorized');
      ixs[1].keys[0]=meta(actor,false,true);
    }
    if (purchaseCount) {
      need(a.balance >= BigInt(purchaseCount) * s.entry, `Not enough ${policy.tokenLabel} for this pack`);
      need((a.playerState?.prepaid ?? 0n) < s.entry, 'Use existing prepaid credits before buying another pack');
      const purchase=[];
      if (!a.playerState) purchase.push(instruction(a.program,1,[meta(who,true,true),meta(a.game),meta(a.player),meta(SystemProgram.programId,false)]));
      const count=Buffer.alloc(8);count.writeBigUInt64LE(BigInt(purchaseCount));
      purchase.push(instruction(a.program,2,[meta(who,true,true),meta(a.game),meta(a.player),meta(a.target),meta(a.vault),meta(a.mint,false),meta(a.tokenProgram,false)],count));
      // The locally constructed purchase and accepted entry succeed atomically.
      ixs.splice(1,0,...purchase);
    }
    if(grantSession){
      const remaining=(a.playerState?.prepaid??0n)/s.entry+BigInt(purchaseCount)-BigInt(batchCount);
      const actor=new PublicKey(grantSession);
      need(remaining>0n && remaining<=10n && !actor.equals(who) && !actor.equals(SystemProgram.programId), 'Invalid remaining play session allowance');
      const data=Buffer.alloc(48);actor.toBuffer().copy(data);data.writeBigUInt64LE(BigInt(a.slot)+8000n,32);data.writeBigUInt64LE(remaining,40);
      ixs.splice(ixs.length-1,0,instruction(a.program,10,[meta(who,false,true),meta(a.game),meta(a.player)],data));
    }
  } else {
    need(s.pending && random.seedSlot === s.seedSlot, 'Pending request changed; refresh before settling');
    if (random.revealSlot <= random.seedSlot) {
      need(ixs.length === 3 && ixs[1].data.length === 98 && ixs[1].data[0] === 15, 'A verified reveal is required before settlement');
      const stats = PublicKey.findProgramAddressSync([Buffer.from('OracleRandomnessStats'),random.oracle.toBuffer()],oracle)[0];
      const state = PublicKey.findProgramAddressSync([Buffer.from('STATE')],oracle)[0];
      checkKeys(ixs[1], [meta(who,true,true),meta(a.game),meta(oracle,false),meta(request),meta(random.oracle,false),meta(s.queue,false),meta(stats),meta(a.game,false),meta(who,true,true),meta(SYSVAR_SLOT_HASHES_PUBKEY,false),meta(SystemProgram.programId,false),meta(getAssociatedTokenAddressSync(NATIVE_MINT,request)),meta(TOKEN_PROGRAM_ID,false),meta(NATIVE_MINT,false),meta(state,false)]);
    } else need(ixs.length === 2, 'This request is already revealed; refresh the settlement draft');
    const settle = ixs.at(-1);
    need(settle.data.equals(Buffer.from([4])), 'Unexpected settlement payload');
    checkKeys(settle, [meta(a.game),meta(addresses(config,s.pending.player).player),meta(request,false),meta(a.vault),meta(a.mint),meta(a.tokenProgram,false)]);
  }
  return { ixs, snapshot: a, validationStartedAt, summary: { action, purchaseCount, batchCount, network: policy.networkLabel, signer: who.toBase58(), game: a.game.toBase58(), mint: a.mint.toBase58(), request: request.toBase58(), acceptedNonce: s.pending?.nonce.toString() ?? null, committedSeedSlot: s.pending ? s.seedSlot.toString() : null, note: action === 'commit' ? `Reserves ${batchCount} prepaid entries and the current pot. One oracle request settles the pack; unused entries after a jackpot return as credits.` : 'Settles the existing accepted spin. Rewards go to its original player; no new random draw is requested.' } };
}
export async function planDevnetSpin(connection, config, wallet, action, fetcher = fetch, options = {}) {
  publicDevnetConfig(config);
  const response = await fetcher('/api/devnet/spin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, wallet: new PublicKey(wallet).toBase58(), action, count: options.batchCount ?? 1 }), signal: AbortSignal.timeout(30000) });
  const payload = await response.json();
  need(response.ok, payload.error || 'Oracle draft service is unavailable');
  return validateSpinDraft(connection, config, wallet, action, payload.instructions, options);
}
