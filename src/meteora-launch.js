// ARCHIVED: superseded by the pump.fun launch. Use only for historical local regression tests.
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, unpackMint, unpackAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { DynamicBondingCurveClient, buildCurve, DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, CollectFeeMode } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
export { DYNAMIC_BONDING_CURVE_PROGRAM_ID, DAMM_V2_PROGRAM_ID };
const U64_MAX = 18446744073709551615n;
const integer = x => BigInt(x.toString());
const equal = (a,b) => new PublicKey(a).equals(new PublicKey(b));
function need(condition, message) { if (!condition) throw new Error(message); }
export function publicKey(value, label = 'address') {
  let key; try { key = new PublicKey(value); } catch { throw new Error(`Invalid Solana ${label}`); }
  need(!key.equals(SystemProgram.programId), `${label} cannot be the system program`); return key;
}
export function validateRoles(config) {
  const roles=Object.fromEntries(['owner','treasury','automation'].map(k=>[k,publicKey(config[k],k)]));
  need(new Set(Object.values(roles).map(k=>k.toBase58())).size===3,'Use separate owner, treasury, and automation wallets');
  need(Object.values(roles).every(k=>PublicKey.isOnCurve(k.toBytes())),'Wallet roles must be signable addresses');
  need(config.quoteAsset==='SOL' && config.launchMode==='meteora-dbc','Expected direct SOL-paired Meteora DBC launch');
  need(config.jackpotShareBps===9000 && config.treasuryShareBps===1000,'Expected 90/10 net collected fee split');
  need(config.executionEnabled===false,'Execution is disabled in the development build'); return roles;
}
export function deriveGameAddresses(mint, gameProgram) {
  const [game]=PublicKey.findProgramAddressSync([Buffer.from('game'),mint.toBuffer()],gameProgram);
  return {game}; // The game account itself holds SOL plus its rent reserve.
}
export function buildLaunchParameters(config) {
  need(config.totalSupply===1_000_000_000 && config.decimals===6,'Development curve uses 1 billion tokens at 6 decimals; re-review changes');
  need(config.migrationQuoteThresholdSol===10 && config.percentageSupplyOnMigration===20,'Development curve uses 10 SOL graduation and 20% migration allocation; re-review changes');
  const m=config.meteora;
  need(m?.tradingFeeBps===200 && m.dynamicFees===false && m.collectFeeMode==='quote' && m.protocolFeePercentExpected===20,'Fee settings differ from the requested launch');
  need(m.partnerTradingFeePercent===100 && m.creatorTradingFeePercent===0 && m.migratedLiquidityPermanentLockPercent===100 && m.partnerCreatorMigrationFeePercent===0 && m.poolCreationFeeLamports==='0' && m.migration==='DAMM-v2' && m.migrationFeeOption==='customizable','Fee rights and locking must stay with this project');
  return buildCurve({
    token:{tokenType:0,tokenBaseDecimal:6,tokenQuoteDecimal:9,tokenAuthorityOption:1,totalTokenSupply:config.totalSupply,leftover:0},
    fee:{baseFeeParams:{baseFeeMode:0,feeSchedulerParam:{startingFeeBps:200,endingFeeBps:200,numberOfPeriod:0,totalDuration:0}},dynamicFeeEnabled:false,collectFeeMode:0,creatorTradingFeePercentage:0,poolCreationFee:0,enableFirstSwapWithMinFee:false},
    migration:{migrationOption:1,migrationFeeOption:6,migrationFee:{feePercentage:0,creatorFeePercentage:0},migratedPoolFee:{collectFeeMode:0,dynamicFee:0,poolFeeBps:200,compoundingFeeBps:0,baseFeeMode:0}},
    liquidityDistribution:{partnerPermanentLockedLiquidityPercentage:100,partnerLiquidityPercentage:0,creatorPermanentLockedLiquidityPercentage:0,creatorLiquidityPercentage:0},
    lockedVesting:{totalLockedVestingAmount:0,numberOfVestingPeriod:0,cliffUnlockAmount:0,totalVestingDuration:0,cliffDurationFromMigrationTime:0},
    activationType:0,percentageSupplyOnMigration:20,migrationQuoteThreshold:10
  });
}
// Creates unsigned instructions only. No private keys, signer loading, or send methods.
export async function draftLaunch(connection,config) {
  const roles=validateRoles(config),params=buildLaunchParameters(config);
  for(const k of ['name','ticker','metadataUri'])need(typeof config[k]==='string' && config[k].length>0,`Missing ${k}`);
  need(new URL(config.metadataUri).protocol==='https:','Metadata must use HTTPS');
  const client=new DynamicBondingCurveClient(connection,'finalized');
  const configKey=publicKey(config.dbcConfig,'fresh DBC config'),mint=publicKey(config.mint,'fresh mint');
  const existing=await connection.getMultipleAccountsInfo([configKey,mint],'finalized');
  need(existing.every(a=>a===null),'Launch requires unused config and mint addresses');
  const configTx=await client.partner.createConfig({...params,config:configKey,quoteMint:NATIVE_MINT,feeClaimer:roles.owner,leftoverReceiver:roles.owner,payer:roles.owner});
  // Config must exist before the SDK can fetch it to build the pool transaction.
  return {configTx,poolParams:{config:configKey,baseMint:mint,payer:roles.owner,poolCreator:roles.owner,name:config.name,symbol:config.ticker,uri:config.metadataUri},executionEnabled:false,curveParametersApproved:config.curveParametersApproved===true};
}
export function verifyDbcConfig(c,config) {
  const roles=validateRoles(config); const b=c.poolFees.baseFee;
  need(equal(c.quoteMint,NATIVE_MINT) && equal(c.feeClaimer,roles.owner) && equal(c.leftoverReceiver,roles.owner),'DBC quote or fee rights mismatch');
  need(c.collectFeeMode===0 && c.creatorTradingFeePercentage===0,'DBC must collect quote with all partner fees owned by the project');
  need(integer(b.cliffFeeNumerator)===20_000_000n && b.baseFeeMode===0 && b.firstFactor===0 && integer(b.secondFactor)===0n && integer(b.thirdFactor)===0n,'DBC fee is not a static 2%');
  need(!c.poolFees.dynamicFee || c.poolFees.dynamicFee.initialized===0,'DBC dynamic fees must be disabled');
  need(c.migrationOption===1 && c.migrationFeeOption===6 && c.migratedCollectFeeMode===0 && c.migratedDynamicFee===0 && c.migratedPoolFeeBps===200 && c.migratedCompoundingFeeBps===0,'Graduation configuration mismatch');
  need(c.partnerPermanentLockedLiquidityPercentage===100 && c.partnerLiquidityPercentage===0 && c.creatorPermanentLockedLiquidityPercentage===0 && c.creatorLiquidityPercentage===0,'Liquidity must be 100% permanently locked for the project partner');
  need(c.migrationFeePercentage===0 && c.creatorMigrationFeePercentage===0 && integer(c.poolCreationFee)===0n,'Unexpected extra partner launch/migration fee');
  need(c.partnerLiquidityVestingInfo.vestingPercentage===0 && c.creatorLiquidityVestingInfo.vestingPercentage===0 && c.migratedPoolBaseFeeMode===0 && c.enableFirstSwapWithMinFee===0,'Unexpected vesting or migrated fee scheduler');
  need(integer(c.preMigrationTokenSupply)===1_000_000_000_000_000n && integer(c.postMigrationTokenSupply)===1_000_000_000_000_000n && integer(c.migrationQuoteThreshold)===10_000_000_000n,'Curve supply/threshold mismatch');
  need(c.tokenType===0 && c.tokenDecimal===6 && c.tokenUpdateAuthority===1,'Expected immutable ordinary SPL token');
  return true;
}
export async function inspectDbc(connection,config) {
  const client=new DynamicBondingCurveClient(connection,'finalized');
  const mint=publicKey(config.mint),poolKey=publicKey(config.dbcPool),configKey=publicKey(config.dbcConfig);
  const infos=await connection.getMultipleAccountsInfo([mint,poolKey,configKey],'finalized');
  need(infos[0]?.owner.equals(TOKEN_PROGRAM_ID),'Expected ordinary SPL mint');
  need(infos[1]?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) && infos[2]?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),'Unverified DBC account owners');
  const token=unpackMint(mint,infos[0],TOKEN_PROGRAM_ID);
  need(token.isInitialized && token.mintAuthority===null && token.freezeAuthority===null && token.decimals===6,'Mint authorities or decimals mismatch');
  const pool=client.state.getProgram().coder.accounts.decode('virtualPool',infos[1].data);
  const settings=client.state.getProgram().coder.accounts.decode('poolConfig',infos[2].data);
  verifyDbcConfig(settings,config);
  need(equal(pool.poolState.baseMint,mint) && equal(pool.poolState.config,configKey),'Pool not bound to this mint/config');
  return {client,pool,settings,token};
}
// Separate verification for DAMM; its OnlyB enum is 1 (DBC QuoteToken is 0).
export function verifyDammState({pool,position,fees,nft},config) {
  need(equal(pool.tokenAMint,config.mint) && equal(pool.tokenBMint,NATIVE_MINT),'DAMM must retain base/SOL ordering');
  need(pool.collectFeeMode===CollectFeeMode.OnlyB,'DAMM must collect SOL on both trade directions');
  need(pool.poolFees.protocolFeePercent===20 && pool.poolFees.compoundingFeeBps===0,'Unexpected protocol or compounding share');
  need(pool.poolFees.dynamicFee.initialized===0,'DAMM dynamic fees must be disabled');
  need(integer(fees.cliffFeeNumerator)===20_000_000n && fees.baseFeeMode===0 && fees.numberOfPeriod===0 && integer(fees.reductionFactor)===0n,'DAMM base fee must stay fixed at 2%');
  need(equal(position.pool,config.dammPool),'Position belongs to another pool');
  need(integer(position.permanentLockedLiquidity)>0n && integer(position.unlockedLiquidity)===0n && integer(position.vestedLiquidity)===0n,'Project position must be permanently locked');
  need(equal(nft.mint,position.nftMint) && equal(nft.owner,config.owner) && nft.amount===1n && nft.delegate===null,'Project must retain sole position NFT ownership');
  // Other LPs must not be able to stop our collection by adding liquidity.
  // The game splits actual position receipts; volume projections use this share.
  dammFeeShare(pool,position);
  return true;
}
export function dammFeeShare(pool,position) {
  const total=integer(pool.liquidity),project=integer(position.permanentLockedLiquidity);
  need(project>0n && total>=project,'Invalid project/pool liquidity');
  return {projectLiquidity:project.toString(),poolLiquidity:total.toString(),ownsAllPoolLiquidity:project===total,
    note:project===total?'Project currently owns all pool liquidity. Split actual collected receipts 90/10.':'Other liquidity dilutes future project fees. Split actual collected project receipts 90/10; the 1.44%/0.16% volume illustration no longer applies in full.'};
}
export async function draftFeeCollection(connection,config,phase) {
  const roles=validateRoles(config);
  const gameProgram=publicKey(config.gameProgram),mint=publicKey(config.mint);
  const {game}=deriveGameAddresses(mint,gameProgram);
  const gameInfo=await connection.getAccountInfo(game,'finalized');
  need(gameInfo?.owner.equals(gameProgram) && gameInfo.data.subarray(0,8).toString()==='SOLPOT03','Game must exist before routed collection; after retirement use the dev fee-recovery draft');
  need(equal(new PublicKey(gameInfo.data.subarray(8,40)),roles.owner) && equal(new PublicKey(gameInfo.data.subarray(40,72)),roles.treasury) && equal(new PublicKey(gameInfo.data.subarray(72,104)),mint),'Game identities do not match fee routing');
  const tokenAAccount=getAssociatedTokenAddressSync(mint,game,true),tokenBAccount=getAssociatedTokenAddressSync(NATIVE_MINT,game,true);
  const pre=[createAssociatedTokenAccountIdempotentInstruction(roles.automation,tokenAAccount,game,mint),createAssociatedTokenAccountIdempotentInstruction(roles.automation,tokenBAccount,game,NATIVE_MINT)];
  const ingest=gameInstruction(gameProgram,13,[game,tokenBAccount,roles.treasury,roles.owner,TOKEN_PROGRAM_ID].map((pubkey,i)=>({pubkey,isSigner:false,isWritable:i<4})));
  if(phase==='dbc') {
    const {client,pool}=await inspectDbc(connection,config);
    const quote=pool.poolState.partnerQuoteFee;
    const tx=await client.state.getProgram().methods.claimTradingFee(new BN(0),new BN('18446744073709551615')).accountsPartial({poolAuthority:deriveDbcPoolAuthority(),pool:publicKey(config.dbcPool),config:publicKey(config.dbcConfig),feeClaimer:roles.owner,tokenAAccount,tokenBAccount,baseVault:pool.poolState.baseVault,quoteVault:pool.poolState.quoteVault,baseMint:mint,quoteMint:NATIVE_MINT,tokenBaseProgram:TOKEN_PROGRAM_ID,tokenQuoteProgram:TOKEN_PROGRAM_ID}).preInstructions(pre).postInstructions([ingest]).transaction();
    return {tx,phase,quotedCollectedLamports:quote.toString(),split:splitCollectedFees(integer(quote)),routing:'Atomically unwrap and split actual collected fees; refund WSOL rent to dev; after shutdown send late receipts to dev',requiresDevSignature:true,executionEnabled:false};
  }
  need(phase==='damm-v2','Specify dbc or damm-v2; old DBC fees may still need a final sweep');
  // Always validate DBC provenance, even after migration.
  const dbc=await inspectDbc(connection,config);
  need(dbc.pool.poolState.isMigrated!==0,'DBC has not graduated');
  const sdk=new CpAmm(connection), poolKey=publicKey(config.dammPool),positionKey=publicKey(config.position),nftKey=publicKey(config.positionNftAccount);
  const infos=await connection.getMultipleAccountsInfo([poolKey,positionKey,nftKey],'finalized');
  need(infos[0]?.owner.equals(DAMM_V2_PROGRAM_ID) && infos[1]?.owner.equals(DAMM_V2_PROGRAM_ID),'Unverified DAMM account owners');
  const [pool,position,fees]=await Promise.all([sdk.fetchPoolState(poolKey),sdk.fetchPositionState(positionKey),sdk.fetchPoolFees(poolKey)]);
  const nft=unpackAccount(nftKey,infos[2],infos[2].owner);
  verifyDammState({pool,position,fees,nft},config);
  const tx=await sdk._program.methods.claimPositionFee().accountsPartial({pool:poolKey,position:positionKey,positionNftAccount:nftKey,signer:roles.owner,tokenAAccount,tokenBAccount,tokenAMint:pool.tokenAMint,tokenBMint:pool.tokenBMint,tokenAVault:pool.tokenAVault,tokenBVault:pool.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID}).preInstructions(pre).postInstructions([ingest]).transaction();
  return {tx,phase,requiresDevSignature:true,executionEnabled:false,feeShare:dammFeeShare(pool,position),routing:'Atomically unwrap and split actual position fees, excluding refundable WSOL account rent'};
}
export function splitCollectedFees(lamports) {
  need(typeof lamports==='bigint' && lamports>=0n && lamports<=U64_MAX,'Fees must be a nonnegative u64 lamport amount');
  const jackpot=lamports*9n/10n; return {jackpot,treasury:lamports-jackpot};
}
export function gameInstruction(programId,tag,keys,payload=Buffer.alloc(0)) {
  return new TransactionInstruction({programId:publicKey(programId),keys,data:Buffer.concat([Buffer.from([tag]),payload])});
}

// After the game is retired the dev still owns DBC fee rights and the permanently
// locked DAMM position NFT. These unsigned recovery instructions pay the dev.
export async function draftDevFeeRecovery(connection,config,phase) {
 const roles=validateRoles(config);const {game}=deriveGameAddresses(publicKey(config.mint),publicKey(config.gameProgram));need(await connection.getAccountInfo(game,'finalized')===null,'Use routed fee collection until the game has been retired');const {client,pool}=await inspectDbc(connection,config);
 if(phase==='dbc')return {tx:await client.partner.claimPartnerTradingFeeToReceiver({feeClaimer:roles.owner,payer:roles.automation,pool:publicKey(config.dbcPool),maxBaseAmount:new BN(0),maxQuoteAmount:new BN('18446744073709551615'),receiver:roles.owner}),executionEnabled:false};
 need(phase==='damm-v2' && pool.poolState.isMigrated!==0,'Expected graduated DAMM v2');
 const sdk=new CpAmm(connection),poolKey=publicKey(config.dammPool),positionKey=publicKey(config.position),nftKey=publicKey(config.positionNftAccount);
 const [p,position,fees,nftInfo]=await Promise.all([sdk.fetchPoolState(poolKey),sdk.fetchPositionState(positionKey),sdk.fetchPoolFees(poolKey),connection.getAccountInfo(nftKey,'finalized')]);
 verifyDammState({pool:p,position,fees,nft:unpackAccount(nftKey,nftInfo,nftInfo.owner)},config);
 return {tx:await sdk.claimPositionFee2({owner:roles.owner,feePayer:roles.automation,receiver:roles.owner,position:positionKey,pool:poolKey,positionNftAccount:nftKey,tokenAMint:p.tokenAMint,tokenBMint:p.tokenBMint,tokenAVault:p.tokenAVault,tokenBVault:p.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID}),executionEnabled:false,feeShare:dammFeeShare(p,position)};
}
