// Active launch path: pump.fun. Builders are unsigned and never submit.
import {PublicKey,SystemProgram,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createCloseAccountInstruction} from '@solana/spl-token';
import {PUMP_SDK,PUMP_PROGRAM_ID,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID,GLOBAL_PDA,PUMP_FEE_CONFIG_PDA,bondingCurvePda,creatorVaultPda,canonicalPumpPoolPda,feeSharingConfigPda,getPumpProgram,getPumpAmmProgram,getPumpFeeProgram} from '@pump-fun/pump-sdk';
import {PUMP_SDK as CURRENT_PUMP_SDK,getPumpAmmProgram as getCurrentPumpAmmProgram} from '@pump-fun/pump-sdk-current';
import {publicKey,validateRoles,deriveGameAddresses} from './launch-common.js';
import {verifyGameMint} from './solana-tokens.js';
import {readGame} from './solana-game.js';
import {pumpFeeAccount,verifyOwnedFeeAccount,draftFeeAccountSetup,draftFeeIngestion,draftPumpShareUpdate} from './pump-fees.js';
export {publicKey,validateRoles,deriveGameAddresses,splitCollectedFees,gameInstruction} from './launch-common.js';
export {PUMP_PROGRAM_ID,PUMP_AMM_PROGRAM_ID,PUMP_FEE_PROGRAM_ID};
const need=(ok,message)=>{if(!ok)throw Error(message);};
const equal=(a,b)=>new PublicKey(a).equals(new PublicKey(b));
export function buildLaunchParameters(config){
 const roles=validateRoles(config),p=config.pumpfun;
 need(!config.meteora&&!config.dbcConfig&&!config.dammPool,'Superseded Meteora settings cannot enter a pump.fun launch');
 need(config.tokenProgram==='token-2022'&&config.decimals===6,'pump.fun create_v2 requires Token-2022 with six decimals');
 need(p?.migration==='PumpSwap'&&p.feePolicy==='platform-defined'&&p.feeSource==='actual-received-creator-fees','Use pump.fun creator receipts and platform fee schedule');
 need(p.mayhemMode===false&&p.cashback===false&&p.holderReward===false,'Use a regular creator-fee coin: no Mayhem, cashback or holder-reward mode');
 need(equal(p.creatorFeeRecipient,roles.owner),'The initial creator must be the project dev');
 need(p.sharingConfig===null||(p.feeRouting==='dev-owned-wsol'&&equal(p.sharingConfig,feeSharingConfigPda(publicKey(config.mint)))),'Unexpected sharing config or fee routing');
 need(p.initialBuyLamports==='0','No dev purchase is included in this launch');
 return {creator:roles.owner,user:roles.owner,mayhemMode:false,cashback:false,holderReward:false};
}
export async function readPumpPolicy(connection){
 const [globalInfo,feeInfo]=await connection.getMultipleAccountsInfo([GLOBAL_PDA,PUMP_FEE_CONFIG_PDA],'finalized');
 need(globalInfo?.owner.equals(PUMP_PROGRAM_ID)&&feeInfo?.owner.equals(PUMP_FEE_PROGRAM_ID),'Pump policy account owners do not match');
 return {global:PUMP_SDK.decodeGlobal(globalInfo),fees:PUMP_SDK.decodeFeeConfig(feeInfo)};
}
export async function draftLaunch(connection,config){
 const params=buildLaunchParameters(config),mint=publicKey(config.mint,'fresh mint');
 need(config.pumpfun.sharingConfig===null,'Token creation precedes fee-sharing setup');
 for(const [field,max]of [['name',32],['ticker',13],['metadataUri',200]])need(typeof config[field]==='string'&&Buffer.byteLength(config[field])>0&&Buffer.byteLength(config[field])<=max,`Invalid ${field}`);
 const uri=new URL(config.metadataUri);need(uri.protocol==='https:'&&!uri.username&&!uri.password,'Metadata must use credential-free HTTPS');
 need(PublicKey.isOnCurve(mint.toBytes())&&![config.owner,config.treasury,config.automation].includes(mint.toBase58()),'Use a fresh mint signer');
 need(await connection.getAccountInfo(mint,'finalized')===null,'Mint address must be unused');
 const policy=await readPumpPolicy(connection);
 need(policy.global.initialized,'Pump global must be initialized');
 const instruction=await PUMP_SDK.createV2Instruction({...params,mint,name:config.name,symbol:config.ticker,uri:config.metadataUri});
 return {tx:new Transaction().add(instruction),executionEnabled:false,gameReady:false,tokenProgram:TOKEN_2022_PROGRAM_ID.toBase58(),supplyBaseUnits:policy.global.tokenTotalSupply.toString(),creatorFeePolicy:'Read current pump.fun schedule; route 90/10 of actual creator receipts only.',migration:'PumpSwap',initialBuyLamports:'0',blockers:['Token-2022 game compatibility and fee routing require end-to-end verification','Mainnet oracle recovery, current costs and signed deployment remain pending']};
}
export function verifyPumpCurve(curve,config){
 buildLaunchParameters(config);
 need(equal(curve.creator,config.pumpfun.sharingConfig??config.owner),'Unexpected curve fee recipient');
 need(equal(curve.quoteMint,SystemProgram.programId)||equal(curve.quoteMint,NATIVE_MINT),'Expected SOL-paired curve');
 need(!curve.isMayhemMode&&!curve.isCashbackCoin&&!curve.isHolderReward,'Unexpected fee diversion or token mode');
 return true;
}
export function verifyPumpPool(pool,config){
 buildLaunchParameters(config);
 need(equal(pool.baseMint,config.mint)&&equal(pool.quoteMint,NATIVE_MINT)&&equal(pool.coinCreator,config.pumpfun.sharingConfig??config.owner),'PumpSwap mint, quote or fee-recipient mismatch');
 need(!pool.isMayhemMode&&!pool.isCashbackCoin&&!pool.isHolderReward,'Unexpected PumpSwap mode');
 return true;
}
export async function inspectPump(connection,config){
 buildLaunchParameters(config);const mint=publicKey(config.mint),curveKey=bondingCurvePda(mint),poolKey=canonicalPumpPoolPda(mint);
 const [mintInfo,curveInfo,poolInfo]=await connection.getMultipleAccountsInfo([mint,curveKey,poolKey],'finalized');
 need(mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)&&curveInfo?.owner.equals(PUMP_PROGRAM_ID),'Unverified token or curve program');
 const token=verifyGameMint(mint,mintInfo,TOKEN_2022_PROGRAM_ID);
 const curve=CURRENT_PUMP_SDK.decodeBondingCurve(curveInfo);verifyPumpCurve(curve,config);
 let pool=null;
 if(poolInfo){need(curve.complete&&poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID),'Unexpected canonical PumpSwap pool');pool=(config.pumpfun.creatorFeeSweeps===true?getCurrentPumpAmmProgram(connection):getPumpAmmProgram(connection)).coder.accounts.decode('pool',poolInfo.data);verifyPumpPool(pool,config);}
 let sharing=null;
 if(config.pumpfun.sharingConfig){const address=feeSharingConfigPda(mint),info=await connection.getAccountInfo(address,'finalized');need(info?.owner.equals(PUMP_FEE_PROGRAM_ID),'Invalid fee-sharing account owner');sharing=getPumpFeeProgram(connection).coder.accounts.decode('sharingConfig',info.data);await verifyRecoverableSharing(sharing,config);}
 return {mint,token,curve,curveKey,pool,poolKey,sharing};
}
// Claiming to the dev is separate from distributing revenue to the game.
// No arbitrary transfers, automatic signing, or unverified 90/10 routing here.
export async function draftCreatorFeeClaim(connection,config,phase){
 const roles=validateRoles(config),state=await inspectPump(connection,config);
 need(!state.sharing,'Shared coins use the recoverable fee-collection plan');
 need(['bonding-curve','pumpswap'].includes(phase),'Choose bonding-curve or pumpswap; residual curve fees remain separately claimable');
 let tx=new Transaction();
 if(phase==='bonding-curve')tx.add(await getPumpProgram(connection).methods.collectCreatorFeeV2().accountsPartial({creator:roles.owner,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,creatorVault:creatorVaultPda(roles.owner)}).instruction());
 else{
  need(state.pool,'Canonical PumpSwap pool has not migrated');
  const ata=getAssociatedTokenAddressSync(NATIVE_MINT,roles.owner);
  tx.add(createAssociatedTokenAccountIdempotentInstruction(roles.automation,ata,roles.owner,NATIVE_MINT));
  tx.add(await getPumpAmmProgram(connection).methods.collectCoinCreatorFee().accountsPartial({coinCreator:roles.owner,coinCreatorTokenAccount:ata,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}).instruction());
 }
 return {tx,phase,executionEnabled:false,recipient:roles.owner.toBase58(),asset:phase==='bonding-curve'?'SOL':'WSOL',routingVerified:false,notes:['Claim destination is the dev, not the pot. Distribution must measure actual receipts and route 90/10.','Creator vaults aggregate by creator. Reserve this creator identity for Solpot.','Protocol/LP fees and unrelated pools are excluded. No dev secret belongs on the worker.']};
}
export async function verifyRecoverableSharing(sharing,config){
 const {address}=await pumpFeeAccount(config.owner,config.mint);
 need(sharing.version===2&&equal(sharing.admin,config.owner)&&sharing.adminRevoked===true&&sharing.shareholders.length===1&&sharing.shareholders[0].address.equals(address)&&sharing.shareholders[0].shareBps===10000,'Fee shares must be fixed entirely to the dedicated dev-owned WSOL account');
 need(equal(sharing.mint,config.mint),'Fee-sharing mint mismatch');
 return address;
}
// Owner-signed setup, kept separate from the permissionless operating worker.
// Fee shares are immutable; only the dedicated account is delegated to the game.
export async function draftRecoverableFeeSetup(connection,config){
 const roles=validateRoles(config);need(config.pumpfun.sharingConfig===null,'Use setup before configuring sharing');
 const state=await inspectPump(connection,config),address=feeSharingConfigPda(state.mint);
 need(!await connection.getAccountInfo(address,'confirmed'),'Fee sharing already exists; inspect it before resuming setup');
 const game=await readGame(connection,config,roles.owner);need(!game.state.closed,'Cannot configure a closed game');
 const account=await draftFeeAccountSetup(connection,config);
 const args={payer:roles.owner,mint:state.mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID};
 const sweeps=config.pumpfun.creatorFeeSweeps===true?[await CURRENT_PUMP_SDK.sweepCreatorFeeInstruction({...args,creator:roles.owner}),...(state.pool?[await CURRENT_PUMP_SDK.sweepPoolCreatorFeeInstruction({...args,coinCreator:roles.owner})]:[])]:[];
 const shares=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...sweeps,await PUMP_SDK.createFeeSharingConfig({creator:roles.owner,mint:state.mint,pool:state.pool?state.poolKey:null}),await draftPumpShareUpdate(roles.owner,state.mint,account.address,!!state.pool));
 return {transactions:[new Transaction().add(...account.ixs),shares],sharingConfig:address.toBase58(),feeAccount:account.address.toBase58(),executionEnabled:false,irreversible:'Pump fee shares become fixed to the dev-owned account. The dev can revoke its game delegation and reconstruct it after game retirement.'};
}
async function feeCollectionInstructions(connection,config,state,payer){
 const sharingAddress=publicKey(config.pumpfun.sharingConfig),ixs=[];let receipts=0n;
 const ammAuthority=PublicKey.findProgramAddressSync([Buffer.from('creator_vault'),sharingAddress.toBuffer()],PUMP_AMM_PROGRAM_ID)[0];
 const ammVault=getAssociatedTokenAddressSync(NATIVE_MINT,ammAuthority,true),curveVault=creatorVaultPda(sharingAddress);
 const [ammInfo,curveInfo]=await connection.getMultipleAccountsInfo([ammVault,curveVault],'confirmed');
 let ammReceipts=0n;
 if(ammInfo){const token=verifyOwnedFeeAccount(ammVault,ammInfo,ammAuthority);need(token.delegate===null,'Unexpected AMM vault delegate');ammReceipts=token.amount;receipts+=token.amount;}
 if(curveInfo)need(curveInfo.owner.equals(SystemProgram.programId)&&curveInfo.data.length===0,'Unexpected curve fee vault');
 const rent=await connection.getMinimumBalanceForRentExemption(0);
 receipts+=BigInt(Math.max(0,(curveInfo?.lamports??0)-rent));
 if(config.pumpfun.creatorFeeSweeps===true){
  const retainedCurve=BigInt(state.curve.creatorFee?.toString()??'0'),retainedPool=BigInt(state.pool?.creatorFees?.toString()??'0');
  need(retainedCurve>=0n&&retainedPool>=0n,'Invalid retained creator fees');
  receipts+=retainedCurve+retainedPool;
  // Always sweep when distributing. Conditional sweeps race trades landing
  // between this read and execution, and can strand an active coin's fees.
  if(receipts>0n){
   const args={payer,mint:state.mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID};
   ixs.push(await CURRENT_PUMP_SDK.sweepCreatorFeeInstruction({...args,creator:sharingAddress}));
   if(state.pool)ixs.push(await CURRENT_PUMP_SDK.sweepPoolCreatorFeeInstruction({...args,coinCreator:sharingAddress}));
   if(state.pool&&(ammReceipts>0n||retainedPool>0n))ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({payer,mint:state.mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
  }
 }else if(ammReceipts>0n)ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({payer,mint:state.mint,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID}));
 if(ixs.length||(curveInfo?.lamports??0)>rent)ixs.push(await PUMP_SDK.distributeCreatorFees({mint:state.mint,sharingConfig:state.sharing,sharingConfigAddress:sharingAddress}));
 return {ixs,receipts};
}
export async function draftFeeCollection(connection,config){
 need(config?.pumpfun?.sharingConfig&&config.pumpfun.feeRouting==='dev-owned-wsol','Recoverable Pump fee setup is not yet verified/configured');
 const roles=validateRoles(config),state=await inspectPump(connection,config),{address}=await pumpFeeAccount(roles.owner,state.mint);
 const feeInfo=await connection.getAccountInfo(address,'confirmed'),token=verifyOwnedFeeAccount(address,feeInfo,roles.owner);
 const game=await readGame(connection,config,roles.automation);
 need(token.delegate?.equals(game.game)&&token.delegatedAmount>=token.amount,'The game fee delegation is missing or exhausted');
 const {ixs,receipts}=await feeCollectionInstructions(connection,config,state,roles.automation);
 const distribution=[...ixs];
 // Include unsynchronized SOL previously distributed to the native account.
 if(ixs.length||BigInt(feeInfo.lamports)>token.rentExemptReserve)ixs.push(await draftFeeIngestion(config,roles.automation));
 let tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...ixs),preparationTx=null;
 if(config.pumpfun.creatorFeeSweeps===true&&distribution.length){
  // Keep the required sweep + distribution atomic. The subsequent game
  // ingestion can safely be separate: receipts stay in the fixed DEV-owned
  // WSOL account until its on-chain measured 90/10 ingestion succeeds.
  const probe=new Transaction({feePayer:roles.automation,recentBlockhash:SystemProgram.programId.toBase58()}).add(...tx.instructions);
  let fits=false;try{fits=probe.serialize({requireAllSignatures:false,verifySignatures:false}).length<=1232}catch{}
  if(!fits){preparationTx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...distribution);tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),await draftFeeIngestion(config,roles.automation));}
 }
 return {tx,preparationTx,hasReceipts:ixs.length>0,estimatedReceiptsLamports:receipts+BigInt(feeInfo.lamports)-token.rentExemptReserve,executionEnabled:false,phase:state.pool?'pumpswap':'bonding-curve',recipient:game.state.closed?roles.owner.toBase58():game.game.toBase58(),closed:game.state.closed,notes:['Unsigned draft only. Recheck network, release identity, simulation and gas budget before signing.','Only the dedicated fee WSOL is delegated; the dev wallet is never delegated.']};
}
export async function draftDevFeeRecovery(connection,config){
 const roles=validateRoles(config),state=await inspectPump(connection,config);need(state.sharing,'Recoverable fee sharing is required');
 const {game}=deriveGameAddresses(state.mint,publicKey(config.gameProgram));
 need(await connection.getAccountInfo(game,'confirmed')===null,'Settle liabilities and retire the game before closing the delegated fee account');
 const account=await draftFeeAccountSetup(connection,config,{delegate:false});
 // CloseAccount accepts an initialized or just reconstructed native account;
 // dev ownership is verified by setup and again by SPL Token at execution.
 return {tx:new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...account.ixs,...(await feeCollectionInstructions(connection,config,state,roles.owner)).ixs,createCloseAccountInstruction(account.address,roles.owner,roles.owner,[],TOKEN_PROGRAM_ID)),executionEnabled:false,recipient:roles.owner.toBase58()};
}
