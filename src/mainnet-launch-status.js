const labels={
 'checking':['SPIN','Connect your wallet now. Availability updates automatically.'],
 'waiting-for-token':['SPIN','Spins open automatically after launch and collected creator fees fund the jackpot.'],
 'waiting-for-randomness':['SPINS PAUSED','The randomness service is unavailable. Spins stay paused until it recovers.'],
 'ready-for-oracle-check':['SPIN','Ready to play. Randomness is verified automatically before purchase.'],
 'confirming-fees':['PREPARING GAME','Confirming the creator-fee setup.'],
 'activating-game':['PREPARING GAME','Activating the game for SLOT.'],
 'waiting-for-creator-fees':['POT FILLING','Waiting for collected creator fees to fund the jackpot.'],
 'settlement-unavailable':['SPINS PAUSED','Automatic settlement is unavailable. Existing rewards stay protected.'],
 'setup-needs-attention':['SPINS PAUSED','Launch setup needs attention.'],
 'closed':['GAME CLOSED','New spins are stopped. Rewards and unused credits remain available.'],
 'verification-pending':['SPINS PAUSED','Unable to verify availability. Retrying automatically; no new entry will be charged.'],
 'ready':['SPIN','SolSlot is ready.'],
};
export function launchPresentation(state){const [title,detail]=labels[state?.launchState]??labels['verification-pending'];return {title,detail};}
export function createMainnetLaunchWatch({onStatus,fetcher=fetch,timers=globalThis,intervalMs=5000}){
 let stopped=true,timer=null,active=null,epoch=0,last={launchState:'checking',gameReady:false,automaticReveal:false};
 const schedule=()=>{if(!stopped&&timer===null)timer=timers.setTimeout(()=>{timer=null;void refresh()},intervalMs);};
 function refresh(){if(active?.epoch===epoch)return active.promise;const request={epoch,promise:null};active=request;request.promise=(async()=>{
  let next;
  try{const r=await fetcher('/api/mainnet/status',{cache:'no-store',signal:AbortSignal.timeout(10000)}),value=await r.json();if(!r.ok||value.network!=='mainnet-beta'||!Object.hasOwn(labels,value.launchState)||typeof value.gameReady!=='boolean'||typeof value.automaticReveal!=='boolean')throw Error('Invalid launch status');next={launchState:value.launchState,gameReady:value.gameReady,automaticReveal:value.gameReady&&value.automaticReveal&&value.launchState==='ready',canPrepareSpin:value.gameReady&&value.canPrepareSpin===true&&value.launchState==='ready-for-oracle-check'};}
  catch{next={...last,launchState:'verification-pending',automaticReveal:false,canPrepareSpin:false};}
  if(request.epoch===epoch){last=next;if(!stopped)await onStatus({...last});}return {...last};
 })().finally(()=>{if(active===request)active=null;if(request.epoch===epoch)schedule()});return request.promise;}
 return {start(){if(stopped){stopped=false;void refresh()}},stop(){stopped=true;epoch++;if(timer!==null){timers.clearTimeout(timer);timer=null;}},refresh};
}
