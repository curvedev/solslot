// Mainnet is a separate adapter. The existing devnet entry points keep their
// explicit devnet checks. No release is enabled by changing an RPC URL.
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import preparedManifest from '../config/mainnet.prepared.json' with {type:'json'};
import {readConfiguredPlayerSnapshot,draftConfiguredGameAction,prepareUnsignedTransaction,signAndSendForNetwork,addresses,decodeGame} from './solana-game.js';
import {executableMainnetRelease} from './mainnet-release.js';
import {ORAO_PROGRAM,ORAO_NETWORK} from './orao-vrf.js';
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const MAINNET_CHAIN='solana:mainnet';
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const need=(ok,message)=>{if(!ok)throw Error(message)};
const keyFields=['gameProgram','mint','owner','treasury','automation','oracleProgram','queue','randomness'];
const digest=async bytes=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export function createMainnetGameAdapter(manifest=preparedManifest,{now=Date.now}={}){
 // Copy once; request objects and caller mutations cannot change the release.
 const release=structuredClone(manifest);
 need(release.cluster===MAINNET_CHAIN&&release.launchMode==='pumpfun'&&release.tokenProgram==='token-2022','Expected the prepared Token-2022 mainnet release');
 need((release.oracleProgram==='SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv'&&release.queue==='A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w')||(release.oracleProgram===ORAO_PROGRAM.toBase58()&&release.queue===ORAO_NETWORK.toBase58()),'Mainnet oracle identity differs from the reviewed deployment');
 for(const name of keyFields)need(new PublicKey(release[name]).toBase58()===release[name]&&release[name]!==SystemProgram.programId.toBase58(),'Invalid mainnet '+name);
 need(new Set(keyFields.map(k=>release[k])).size===keyFields.length,'Mainnet roles and program identities must be separate');
 need(Number.isSafeInteger(release.release?.binaryBytes)&&release.release.binaryBytes>0&&/^[a-f0-9]{64}$/.test(release.release.binarySha256),'Missing reviewed game binary identity');
 function publicConfig(value){
  need(value&&typeof value==='object'&&!Array.isArray(value),'Expected public mainnet configuration');
  need(!Object.keys(value).some(k=>/secret|private|mnemonic|password|seedphrase/i.test(k)),'Never load wallet secrets into public configuration');
  need(value.cluster===MAINNET_CHAIN,'An explicit Solana mainnet configuration is required');
  for(const name of keyFields)need(value[name]===release[name],'Mainnet '+name+' differs from the pinned release');
  need(value.tokenProgram==='token-2022'||value.tokenProgram===TOKEN_2022_PROGRAM_ID.toBase58(),'Mainnet uses Token-2022');
  need(value.batchSpins===true,'Mainnet uses atomic 1/5/10-spin packs');
  return Object.freeze({cluster:MAINNET_CHAIN,...Object.fromEntries(keyFields.map(k=>[k,release[k]])),tokenProgram:TOKEN_2022_PROGRAM_ID.toBase58(),batchSpins:true,entryTokens:release.entryTokens??'200000',consolationTokens:release.consolationTokens??'100000',...(release.automationExternalSpentLamports===undefined?{}:{automationExternalSpentLamports:release.automationExternalSpentLamports})});
 }
 const config=publicConfig(release);
 const verifiedPrograms=new WeakMap();
 async function assertNetwork(connection,{entry=false,fresh=true}={}){
  need(executableMainnetRelease(release),'Mainnet deployment has not been verified; no real transaction is enabled');
  if(entry){need(release.release.entriesEnabled===true,'Mainnet entries are paused; rewards and refunds remain available');need(release.pumpfun?.tokenCreation!=='owner-launcher'||release.pumpfun.externalMintConfirmed===true,'The owner-supplied launch CA has not been confirmed');}
  const endpoint=connection.rpcEndpoint,reader=connection.getGenesisHash;
  need(await reader.call(connection)===MAINNET_GENESIS,'RPC is not Solana mainnet');
  need(connection.rpcEndpoint===endpoint&&connection.getGenesisHash===reader,'RPC changed during mainnet verification');
  const program=new PublicKey(config.gameProgram),[pd]=PublicKey.findProgramAddressSync([program.toBuffer()],loader);
  const cached=verifiedPrograms.get(connection),light=!fresh&&cached&&cached.until>now()&&cached.endpoint===endpoint&&cached.reader===reader&&cached.accountReader===connection.getMultipleAccountsInfo;
  const [executable,data]=await connection.getMultipleAccountsInfo([program,pd],light?{commitment:'finalized',dataSlice:{offset:0,length:45}}:'finalized');
  need(executable?.executable&&executable.owner.equals(loader)&&executable.data.length===36&&executable.data.readUInt32LE(0)===2&&new PublicKey(executable.data.subarray(4,36)).equals(pd),'Unexpected mainnet game program');
  need(data?.owner.equals(loader)&&data.data.length===(light?45:45+release.release.binaryBytes)&&data.data.readUInt32LE(0)===3&&data.data[12]===1&&new PublicKey(data.data.subarray(13,45)).toBase58()===config.owner,'Mainnet deployment authority or allocation differs from the reviewed release');
  if(light){
   // The upgradeable loader changes this header on a code/authority change.
   // Never extend its TTL from a cheap check, or use it at a signing boundary.
   need(data.data.equals(cached.header),'Mainnet program upgrade detected; refresh the full reviewed release');
  }else{
   need(await digest(data.data.subarray(45))===release.release.binarySha256,'Mainnet game bytecode changed; review it before signing');
   verifiedPrograms.set(connection,{endpoint,reader,accountReader:connection.getMultipleAccountsInfo,until:now()+60000,header:Buffer.from(data.data.subarray(0,45))});
  }
  if(entry&&['prelaunch-armed','prelaunch-staged'].includes(release.release.status)){
   const a=addresses(config,config.owner),info=await connection.getAccountInfo(a.game,'confirmed');
   need(info?.owner.equals(program),'Prepared game is unavailable');const state=decodeGame(info.data);
   for(const name of ['owner','treasury','mint','oracleProgram','queue'])need(state[name].toBase58()===config[name],'Prepared game identity changed');
   need(state.entry===BigInt(config.entryTokens)*1000000n&&state.consolation===BigInt(config.consolationTokens)*1000000n,'Game prices differ from the pinned release');
   need(state.launchReady&&!state.closed&&state.pot>0n,'Entries wait for token activation and collected creator fees');
  }
  need(connection.rpcEndpoint===endpoint&&connection.getGenesisHash===reader,'RPC changed while checking the release');
 }
 const isEntry=ixs=>ixs.some(ix=>ix.programId.toBase58()===config.gameProgram&&[2,3,17,23].includes(ix.data[0]));
 async function readSnapshot(connection,value,wallet){publicConfig(value);await assertNetwork(connection,{fresh:false});return readConfiguredPlayerSnapshot(connection,config,wallet);}
 async function planAction(connection,value,wallet,action,count=1){publicConfig(value);await assertNetwork(connection,{entry:action==='buy'});return draftConfiguredGameAction(connection,config,wallet,action,count,'Solana mainnet — real SOL and SLOT');}
 async function prepare(connection,wallet,ixs){
  const entry=isEntry(ixs);await assertNetwork(connection,{entry});
  const result=await prepareUnsignedTransaction(connection,wallet,ixs);
  need(result.baseFeeLamports<=100000,'Network fee exceeds the player transaction limit');
  return {...result,mainnetEntry:entry};
 }
 async function signAndSend(connection,provider,reviewed,wallet,onSubmitted=()=>{},beforeBroadcast=()=>{}){
  need(typeof reviewed.mainnetEntry==='boolean','Only a mainnet-prepared transaction can be signed');
  return signAndSendForNetwork(c=>assertNetwork(c,{entry:reviewed.mainnetEntry}),connection,provider,reviewed,wallet,onSubmitted,beforeBroadcast);
 }
 return Object.freeze({config,publicConfig,assertNetwork,readSnapshot,planAction,prepare,signAndSend});
}
export const mainnetGame=createMainnetGameAdapter();
