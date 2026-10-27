import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { confirmSubmittedTransaction } from './confirm-transaction.js';
import { simulateTransactionWithContext } from './transaction-simulation.js';
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

import { gameTokenProgram, verifyGameMint, verifyGameTokenAccount } from './solana-tokens.js';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const key = value => new PublicKey(value);
const meta = (pubkey, isWritable = true, isSigner = false) => ({ pubkey, isWritable, isSigner });
export function publicDevnetConfig(value) {
  need(value && typeof value === 'object' && !Array.isArray(value), 'Choose a public game configuration');
  need(!Object.keys(value).some(k => /secret|private|seed|mnemonic|password/i.test(k)), 'Never load wallet secrets');
  need(value.cluster === 'solana:devnet', 'Only an explicit solana:devnet configuration is accepted');
  const config = { cluster: value.cluster };
  for (const name of ['gameProgram', 'mint', 'owner', 'treasury', 'oracleProgram', 'queue', 'randomness']) {
    need(typeof value[name] === 'string' && value[name].length > 0, `Missing ${name}`);
    config[name] = key(value[name]).toBase58();
    need(config[name] !== SystemProgram.programId.toBase58(), `Invalid ${name}`);
  }
  need(config.owner !== config.treasury, 'Dev and treasury must be different wallets');
  need(config.oracleProgram === 'Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2' && config.queue === 'EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7', 'Use the reviewed Switchboard devnet program and queue');
  if (value.tokenProgram !== undefined) config.tokenProgram = gameTokenProgram(value).toBase58();
  config.batchSpins = value.batchSpins === true;
  return Object.freeze(config);
}
export function addresses(config, wallet) {
  const program = key(config.gameProgram), mint = key(config.mint), tokenProgram = gameTokenProgram(config);
  const [game] = PublicKey.findProgramAddressSync([Buffer.from('game'), mint.toBuffer()], program);
  const [player] = PublicKey.findProgramAddressSync([Buffer.from('player'), game.toBuffer(), key(wallet).toBuffer()], program);
  return { program, mint, tokenProgram, game, player, vault: getAssociatedTokenAddressSync(mint, game, true, tokenProgram), target: getAssociatedTokenAddressSync(mint, key(wallet), false, tokenProgram), feeVault: getAssociatedTokenAddressSync(NATIVE_MINT, game, true) };
}
export function instruction(programId, tag, keys, payload = Buffer.alloc(0)) {
  return new TransactionInstruction({ programId, keys, data: Buffer.concat([Buffer.from([tag]), payload]) });
}
export function decodeGame(data) {
  const b = Buffer.from(data); need(b.length === 512 && ['SOLPOT03','SOLPRE01'].includes(b.subarray(0, 8).toString()), 'Unrecognized game account');
  let offset = 8;
  const pk = () => { const v = new PublicKey(b.subarray(offset, offset + 32)); offset += 32; return v; };
  const u64 = () => { const v = b.readBigUInt64LE(offset); offset += 8; return v; };
  const owner = pk(), treasury = pk(), mint = pk(), oracleProgram = pk(), queue = pk();
  const bump = b[offset++], decimals = b[offset++], seedSlot = u64(), openPlayers = u64(), openOracles = u64(), entry = u64(), pot = u64();
  const flag = b[offset++]; need(flag === 0 || flag === 1, 'Invalid pending-spin state');
  const pending = flag ? { nonce: u64(), player: pk(), request: pk(), lockedPot: u64() } : null;
  const nextNonce = u64(), tokenLiability = u64(), solLiability = u64(), prepaidLiability = u64(), burned = u64(), closedFlag = b[offset++];
  const pendingCount = pending ? b[offset] || 1 : 0;
  need(pendingCount <= 10, 'Invalid pending pack size');
  if (pending) pending.count = pendingCount;
  const fullBack = b[offset + 1];
  need(decimals === 6 && ((entry === 200000000000n && fullBack === 0) || (entry === 50000000000n && fullBack === 1)) && closedFlag <= 1, 'Game rules differ from this build');
  return { owner, treasury, mint, oracleProgram, queue, bump, decimals, seedSlot, openPlayers, openOracles, entry, consolation:fullBack ? entry : entry/2n, pot, pending, nextNonce, tokenLiability, solLiability, prepaidLiability, burned, closed: closedFlag === 1, launchReady:b.subarray(0,8).toString()==='SOLPOT03' };
}
const verifiedNetworks = new WeakMap();
export async function assertDevnet(connection, { fresh = true } = {}) {
  const cached = verifiedNetworks.get(connection);
  // Cache identity only for read-only preparation. Signing always uses the
  // default fresh check on both sides of the wallet approval.
  if (!fresh && cached && cached.expires > Date.now() && cached.endpoint === connection.rpcEndpoint && cached.getGenesisHash === connection.getGenesisHash) return;
  const endpoint = connection.rpcEndpoint, getGenesisHash = connection.getGenesisHash;
  verifiedNetworks.delete(connection);
  const genesis = await getGenesisHash.call(connection);
  need(endpoint === connection.rpcEndpoint && getGenesisHash === connection.getGenesisHash, 'RPC changed during the network check');
  need(genesis === DEVNET_GENESIS, 'This wallet console only permits Solana devnet');
  verifiedNetworks.set(connection, { endpoint, getGenesisHash, expires: Date.now() + 30000 });
}
export async function readGame(connection, config, wallet) {
  const a = addresses(config, wallet);
  const [info, mintInfo] = await Promise.all([connection.getAccountInfo(a.game, 'confirmed'), connection.getAccountInfo(a.mint, 'confirmed')]);
  verifyGameMint(a.mint, mintInfo, a.tokenProgram);
  need(info?.owner.equals(a.program), 'Game is missing or owned by a different program');
  const state = decodeGame(info.data);
  need(state.launchReady, 'Game is reserved for launch; entries are not activated');
  need(state.mint.equals(a.mint) && state.owner.equals(key(config.owner)) && state.treasury.equals(key(config.treasury)), 'Game identities do not match the supplied configuration');
  return { ...a, state };
}
export function decodePlayer(data) {
  const b = Buffer.from(data);
  need(b.length === 256 && b.subarray(0, 8).toString() === 'PLAYER02', 'Unrecognized player account');
  const receipt = decodeBatchReceipt(b);
  return { receipt, game: key(b.subarray(8, 40)), wallet: key(b.subarray(40, 72)), prepaid: b.readBigUInt64LE(72), tokenRewards: b.readBigUInt64LE(80), solRewards: b.readBigUInt64LE(88), session: key(b.subarray(96,128)), sessionExpiry: b.readBigUInt64LE(128), sessionSpins: b.readBigUInt64LE(136) };
}
export function decodeBatchReceipt(b) {
  const requested=b[169], played=b[170];
  if (!requested) { need(!played, 'Invalid empty pack receipt'); return null; }
  const nonce=b.readBigUInt64LE(145), seedSlot=b.readBigUInt64LE(153), lockedPot=b.readBigUInt64LE(161);
  need(requested<=10 && played>0 && played<=requested && nonce>0n && seedSlot>0n && lockedPot>0n, 'Invalid pack receipt');
  const draws=Array.from({length:requested},(_,i)=>b.readUInt16LE(171+i*2));
  need(draws.every(n=>n>=1 && n<=400), 'Invalid pack draw');
  const jackpot=draws.findIndex(n=>n<=4);
  need(played===(jackpot<0?requested:jackpot+1), 'Invalid pack stopping point');
  return {nonce,seedSlot,lockedPot,requested,played,draws,request:key(b.subarray(191,223))};
}
export async function readPlayerSnapshot(connection, config, wallet) {
  await assertDevnet(connection, { fresh: false });
  return readConfiguredPlayerSnapshot(connection, config, wallet);
}
// Shared read/draft primitives never choose a network or submit a transaction.
// Each network adapter must validate its pinned configuration and RPC identity.
export async function readConfiguredPlayerSnapshot(connection, config, wallet) {
  const a = addresses(config, wallet);
  // A single RPC context keeps the pot, credits and rewards in the same bank view.
  const response = await connection.getMultipleAccountsInfoAndContext([a.game, a.player, a.target, key(wallet), a.mint], { commitment: 'confirmed' });
  const [game, player, tokens, native, mintInfo] = response.value;
  verifyGameMint(a.mint, mintInfo, a.tokenProgram);
  need(game?.owner.equals(a.program), 'Game is missing or owned by a different program');
  const s = decodeGame(game.data);
  need(s.launchReady, 'Game is reserved for launch; entries are not activated');
  need(s.mint.equals(a.mint) && s.owner.equals(key(config.owner)) && s.treasury.equals(key(config.treasury)) && s.oracleProgram.equals(key(config.oracleProgram)) && s.queue.equals(key(config.queue)), 'On-chain game identities do not match configuration');
  let p = null, balance = 0n;
  if (player) {
    need(player.owner.equals(a.program), 'Player account has an unexpected owner');
    p = decodePlayer(player.data);
    need(p.game.equals(a.game) && p.wallet.equals(key(wallet)), 'Player account belongs to another game or wallet');
  }
  if (tokens) {
    const token = verifyGameTokenAccount(a.target, tokens, a.mint, key(wallet), a.tokenProgram);
    balance = token.amount;
  }
  return { ...a, state: s, playerState: p, balance, solBalance: BigInt(native?.lamports ?? 0), slot: response.context.slot };
}
export async function planGameAction(connection, config, wallet, action, count = 1) {
  await assertDevnet(connection, { fresh: false });
  need(config.cluster === 'solana:devnet', 'Configuration must explicitly select devnet');
  return draftConfiguredGameAction(connection,config,wallet,action,count,'Solana devnet — test funds');
}
export async function draftConfiguredGameAction(connection, config, wallet, action, count, networkLabel) {
  const who = key(wallet), a = await readGame(connection, config, who), s = a.state, ixs = [];
  const owner = meta(who, true, true), game = meta(a.game), player = meta(a.player);
  const ix = (tag, keys, data) => instruction(a.program, tag, keys, data);
  if (['shutdown', 'retire'].includes(action)) need(who.equals(s.owner), 'Connect the configured dev wallet');
  if (action === 'buy') {
    need(!s.closed && [1, 5, 10].includes(count), 'Select 1, 5, or 10 spins in an open game');
    if (!await connection.getAccountInfo(a.player, 'confirmed')) ixs.push(ix(1, [owner, game, player, meta(SystemProgram.programId, false)]));
    const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(count));
    ixs.push(ix(2, [owner, game, player, meta(a.target), meta(a.vault), meta(a.mint, false), meta(a.tokenProgram, false)], data));
  } else if (['claim', 'refund'].includes(action)) {
    if(action==='refund')ixs.push(ix(10,[owner,game,player],Buffer.alloc(48)));
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(who, a.target, who, a.mint, a.tokenProgram));
    ixs.push(ix(action === 'claim' ? 5 : 6, [owner, game, player, meta(a.vault), meta(a.target), meta(a.mint, false), meta(a.tokenProgram, false)]));
  } else if (action === 'close-player') ixs.push(ix(11, [owner, game, player]));
  else if (action === 'shutdown') ixs.push(ix(9, [owner, game]));
  else if (action === 'retire') {
    need(s.closed && !s.pending && s.openPlayers === 0n && s.openOracles === 0n && s.tokenLiability === 0n && s.solLiability === 0n && s.prepaidLiability === 0n, 'Clear player obligations, player accounts, and oracle accounts before retirement');
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(who, a.target, who, a.mint, a.tokenProgram));
    ixs.push(ix(12, [owner, game, meta(a.vault), meta(a.target), meta(a.mint, false), meta(a.tokenProgram, false), meta(a.feeVault, false)]));
  } else throw new Error('Unsupported game action');
  return { ixs, summary: { action, network: networkLabel, signer: who.toBase58(), game: a.game.toBase58(), mint: a.mint.toBase58(), owner: s.owner.toBase58(), treasury: s.treasury.toBase58(), tokenEntry: action === 'buy' ? String(BigInt(count) * s.entry / 1000000n) : null, protectedSolLamports: String(s.solLiability + (s.pending?.lockedPot ?? 0n)), note: 'Shutdown preserves accepted prizes and unused player credits. Retiring never closes permanently locked liquidity.' } };
}
export async function prepareDevnetTransaction(connection, wallet, ixs) {
  await assertDevnet(connection, { fresh: false });
  return prepareUnsignedTransaction(connection,wallet,ixs);
}
export async function prepareUnsignedTransaction(connection, wallet, ixs) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: key(wallet), recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message());
  const [simulation, fee] = await Promise.all([
    connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' }),
    connection.getFeeForMessage(tx.message, 'confirmed'),
  ]);
  need(!simulation.value.err, 'Transaction simulation failed; nothing was signed');
  need(fee.value !== null, 'Transaction fee could not be quoted');
  return { tx, latest, baseFeeLamports: fee.value };
}
export async function signAndSendDevnet(connection, provider, prepared, expectedWallet, onSubmitted = () => {}, beforeBroadcast = () => {}) {
  return signAndSendForNetwork(assertDevnet,connection,provider,prepared,expectedWallet,onSubmitted,beforeBroadcast);
}
// The signing adapter supplies its fixed network/release check. Never expose
// this function directly to an HTTP-provided policy or unsigned instruction list.
export async function signAndSendForNetwork(assertNetwork,connection,provider,prepared,expectedWallet,onSubmitted=()=>{},beforeBroadcast=()=>{}) {
  need(prepared.minContextSlot === undefined || (Number.isSafeInteger(prepared.minContextSlot) && prepared.minContextSlot >= 0), 'Invalid transaction context slot');
  const context = prepared.minContextSlot === undefined ? {} : { minContextSlot: prepared.minContextSlot };
  await assertNetwork(connection);
  need(provider.publicKey?.equals(key(expectedWallet)), 'Wallet account changed; prepare again');
  const before = Buffer.from(prepared.tx.message.serialize());
  const signed = await provider.signTransaction(prepared.tx);
  need(before.equals(Buffer.from(signed.message.serialize())), 'Wallet changed the reviewed transaction');
  need(provider.publicKey?.equals(key(expectedWallet)), 'Wallet account changed while signing; prepare again');
  await assertNetwork(connection);
  const simulationOptions = { sigVerify: true, commitment: 'confirmed', ...context };
  const simulation = prepared.minContextSlot === undefined
    ? await connection.simulateTransaction(signed, simulationOptions)
    : await simulateTransactionWithContext(connection, signed, simulationOptions);
  need(!simulation.value.err, 'Signed transaction simulation failed; nothing was sent');
  const signature = bs58.encode(signed.signatures[0]);
  beforeBroadcast();
  // Persist the deterministic signature before the RPC call: a transport error
  // can occur after broadcast, and must not erase the transaction's receipt.
  onSubmitted(signature);
  let returned;
  // Match the blockhash and signed simulation commitment. A connection used
  // for finalized account audits may otherwise preflight against an older bank
  // that has not seen this confirmed blockhash yet.
  try { returned = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2, ...context }); }
  catch (cause) { throw new Error('Broadcast status is unknown. Check the saved receipt before preparing another transaction.', {cause}); }
  need(returned === signature, 'RPC returned a different transaction signature. Check the saved receipt before retrying');
  let result;
  try { result = await confirmSubmittedTransaction(connection, { ...prepared.latest, signature }); }
  catch { throw new Error('Transaction was submitted, but confirmation is unknown. Check the receipt before attempting the action again.'); }
  need(!result.value.err, 'Transaction was submitted but did not succeed');
  return signature;
}
