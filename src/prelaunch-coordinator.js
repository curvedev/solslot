// Private worker orchestration. There is no public endpoint that can arm it,
// supply a transaction or change the pinned mint and wallet roles.
export function createPrelaunchCoordinator({inspect,feeBroadcaster,activate,collectFees,operatingReady,preparationReady}){
 for(const fn of [inspect,activate,collectFees,operatingReady,preparationReady])if(typeof fn!=='function')throw Error('Complete launch services are required');
 if(!feeBroadcaster?.send||!feeBroadcaster?.reconcile)throw Error('Verified fixed fee permissions are required');
 let active=null,state='checking',checkedAt=0,gameReady=false;
 const result=value=>{state=value;checkedAt=Date.now();return {launchState:state,gameReady,automaticReveal:state==='ready',canPrepareSpin:state==='ready-for-oracle-check',checkedAt};};
 async function step(){
  try{
   // Inspection verifies the exact program, DEV roles, mint, Pump modes,
   // fee delegation and prepared oracle every time, including after restart.
   let current=await inspect();gameReady=current.gameReady===true;
   if(current.closed)return result('closed');
   // A staged release may serve a waiting page, but cannot spend either the
   // owner's saved capability or automation gas until live admission passes.
   const preparation=await preparationReady({allowProbe:current.mintExists&&!current.gameReady});
   if(!preparation.ready){
    // An idle network has no fresh traffic. The fully funded private probe can
    // run at launch or on an explicit purchase; no idle timer buys requests.
    if(preparation.reason==='oracle-idle'&&preparation.canPrepareSpin){
     if(!current.mintExists)return result('waiting-for-token');
     if(current.gameReady&&current.feeSharesReady){
      if((await feeBroadcaster.reconcile()).pending)return result('confirming-fees');
      // Fee collection can fill an empty pot without admitting a player or
      // buying oracle traffic. The first explicit purchase verifies health.
      if(BigInt(current.potLamports)===0n){await collectFees();current=await inspect();if(current.closed)return result('closed');}
      return result(BigInt(current.potLamports)>0n?'ready-for-oracle-check':'waiting-for-creator-fees');
     }
    }
    return result(['oracle-unavailable','oracle-probe-pending','oracle-idle'].includes(preparation.reason)?'waiting-for-randomness':'settlement-unavailable');
   }
   if(!current.mintExists)return result('waiting-for-token');
   if(!current.feeSharesReady){
    const fee=await feeBroadcaster.send(current.graduated);
    if(fee.state==='fee-approval-failed')return result('setup-needs-attention');
    if(fee.state!=='fees-confirmed')return result('confirming-fees');
    current=await inspect();
    gameReady=current.gameReady===true;
    if(!current.feeSharesReady)return result('confirming-fees');
   }
   // Even if routing is already correct, do not forget an uncertain DEV debit.
   if((await feeBroadcaster.reconcile()).pending)return result('confirming-fees');
   if(!current.gameReady){
    await activate(); // Must use the existing gas ledger and fixed instruction plan.
    current=await inspect();
    gameReady=current.gameReady===true;
    if(!current.gameReady)return result('activating-game');
   }
   if(current.closed)return result('closed');
   if(BigInt(current.potLamports)===0n){
    await collectFees();
    current=await inspect();
    if(current.closed)return result('closed');
    if(BigInt(current.potLamports)===0n)return result('waiting-for-creator-fees');
   }
   if(!await operatingReady())return result('settlement-unavailable');
   return result('ready');
  }catch(error){state='verification-pending';checkedAt=0;throw error;}
 }
 return {
  tick(){if(!active)active=step().finally(()=>{active=null});return active;},
  status(){const fresh=Date.now()-checkedAt<20000;return {launchState:state,gameReady,readyToLaunch:state==='waiting-for-token'&&fresh,automaticReveal:state==='ready'&&fresh,canPrepareSpin:state==='ready-for-oracle-check'&&fresh,checkedAt};},
  async drain(){await active?.catch(()=>{});},
 };
}
