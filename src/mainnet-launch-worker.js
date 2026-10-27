// Fixed launch permissions stay on the private mounted volume, never in HTTP.
import {readFileSync,lstatSync,writeFileSync,renameSync,openSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {createPrelaunchCoordinator} from './prelaunch-coordinator.js';
import {createPrelaunchFeeBroadcaster} from './prelaunch-broadcast.js';
import {createPrelaunchInspection} from './prelaunch-readiness.js';
import {launchReviewId} from './launch-review-id.js';
const need=(ok,message)=>{if(!ok)throw Error(message)};
export function privateLaunchJson(path){
 const st=lstatSync(path);need(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&st.size<64000,'Invalid private launch file');
 return JSON.parse(readFileSync(path,'utf8'));
}
export function savePrivateLaunchJson(path,value){
 const tmp=path+'.'+randomUUID()+'.tmp';
 try{writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});const fd=openSync(tmp,'r');try{fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir)}finally{closeSync(dir)}}finally{try{unlinkSync(tmp)}catch(e){if(e.code!=='ENOENT')throw e}}
}
export async function verifyLaunchProgramPins(connection,pins){
 need(Array.isArray(pins)&&pins.length>=6&&pins.length<=10,'Reviewed launch program identities are missing');
 const snapshots=[];
 for(const pin of pins){const info=await connection.getAccountInfo(new PublicKey(pin.address),'finalized');need(info&&info.owner.toBase58()===pin.owner&&info.executable===pin.executable&&info.data.length===pin.bytes&&createHash('sha256').update(info.data).digest('hex')===pin.dataSha256,'A reviewed launch program changed; recheck before submitting saved approvals');snapshots.push({address:pin.address,owner:pin.owner,executable:pin.executable,header:info.data.subarray(0,45).toString('base64')});}
 return snapshots;
}
export async function verifyLaunchProgramHeaders(connection,snapshots){
 need(Array.isArray(snapshots)&&snapshots.length>=6&&snapshots.length<=10,'Missing reviewed program headers');
 // Upgradeable program bytecode can change only through its loader, which
 // changes the upgrade slot in this header. Recheck these small slices while
 // waiting; retain full-bytecode verification immediately before broadcast.
 const values=await connection.getMultipleAccountsInfo(snapshots.map(s=>new PublicKey(s.address)),{commitment:'finalized',dataSlice:{offset:0,length:45}});
 need(values.length===snapshots.length,'Incomplete program header check');
 for(const [i,info]of values.entries()){const s=snapshots[i];need(info&&info.owner.toBase58()===s.owner&&info.executable===s.executable&&info.data.toString('base64')===s.header,'A reviewed launch program changed; launch is paused for review');}
}
export async function createMainnetLaunchWorker({config,connection,settler,runtime,inspect=createPrelaunchInspection(connection,config),files=null,checkPrograms=()=>verifyLaunchProgramPins(connection,config.prelaunch.programPins)}){
 need(config.prelaunch?.enabled===true,'Prelaunch release required');
 const statePath=join(runtime,'launch-ledger.json');
 const approvals=files?.approvals??privateLaunchJson(join(runtime,'launch-approvals.json'));
 const ledger=files?.ledger??privateLaunchJson(statePath),save=files?.save??(value=>savePrivateLaunchJson(statePath,value));
 const reviewedHeaders=await checkPrograms();
 const inspectReviewed=async()=>{if(reviewedHeaders)await verifyLaunchProgramHeaders(connection,reviewedHeaders);return inspect();};
 const broadcaster=await createPrelaunchFeeBroadcaster({config,connection,approvals,ledger,save,assertReady:async graduated=>{
  await checkPrograms();const state=await inspect();need(!state.closed&&state.mintExists&&!state.feeSharesReady&&state.graduated===graduated,'Launch phase or fee state changed');
 }});
 const coordinator=createPrelaunchCoordinator({inspect:inspectReviewed,feeBroadcaster:broadcaster,activate:()=>settler.activate(),collectFees:()=>settler.collectFees({emptyPot:true}),preparationReady:options=>settler.prelaunchReady(options),operatingReady:async()=> (await settler.status()).automaticReveal===true});
 let recovering=null;
 return {
  payer:settler.payer,
  settle:ref=>settler.settle(ref),
  async ensureEntryOracle(body){await settler.ensureEntryOracle(body);await coordinator.tick();},
  async status(){const launch={...coordinator.status(),launchReviewId:launchReviewId(config)};if(!launch.automaticReveal)return {...launch,reason:launch.launchState};const live=await settler.status();return {...launch,...live,...(live.canPrepareSpin?{launchState:'ready-for-oracle-check'}:{}),automaticReveal:live.automaticReveal===true};},
  recoverPending(){if(!recovering)recovering=(async()=>{
   // Verification failures stop new entries; recovery of an already accepted
   // result remains independent and retains its own release/identity checks.
   try{await coordinator.tick();}finally{if(coordinator.status().gameReady)await settler.recoverPending();}
   return coordinator.status();
  })().finally(()=>{recovering=null});return recovering;},
  async drain(){await recovering?.catch(()=>{});await coordinator.drain();await settler.drain();},
 };
}
