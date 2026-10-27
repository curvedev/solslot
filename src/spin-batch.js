// Playback exists only in page memory. Batch-capable programs settle all
// accepted entries first; legacy configurations retain the sequential path.
export async function playSpinBatch({game,count,purchaseCount=count,shouldContinue=()=>true,onProgress=()=>{},onSettled=()=>{},onResult=async()=>{}}){
 if(!Number.isInteger(count)||count<1||count>10)throw Error('Choose up to ten spins');
 // Batch-capable programs settle once before any animations. A stop after
 // acceptance skips presentation only; it cannot cancel committed outcomes.
 if(game.view().config?.batchSpins){
  let results=[];
  try{
   if(!shouldContinue())return {results,requested:count,reason:'stopped'};
   onProgress({index:1,count,completed:0,settling:true});
   const entry=await game.act('spin',purchaseCount,{batchCount:count,shouldContinue});
   if(entry?.cancelled)return {results,requested:count,reason:'cancelled'};
   const response=await game.finishSpin();
   results=response?.results??(response?.result?[response.result]:[]);
   if(!results.length)return {results,requested:count,reason:'result-unavailable'};
   await onSettled(results);
   for(const [index,result] of results.entries()){
    if(!shouldContinue())break;
    onProgress({index:index+1,count,completed:results.length,settling:false});
    await onResult(result,index+1);
   }
   return {results,requested:count,reason:results.some(r=>r.won)?'jackpot':'complete'};
  }catch(error){return {results,requested:count,reason:error.code==='SPIN_STOPPED'?'stopped':'error',error};}
 }
 const results=[];let reason='',error=null;
 for(let index=0;index<count;index++){
  if(!shouldContinue()){reason='stopped';break;}
  const view=game.view(),s=view.snapshot?.state;
  if(index>0){
   if(s?.closed||!s?.pot){reason='game-unavailable';break;}
   if(s.pending||view.receipt){reason='pending';break;}
   if(!view.sessionReady){reason='session-ended';break;}
  }
  onProgress({index:index+1,count,completed:results.length});
  try{
   const entry=await game.act('spin',index===0?purchaseCount:1,{sessionOnly:index>0,shouldContinue});
   if(entry?.cancelled){reason='cancelled';break;}
   // Stopping prevents future entries, but never skips an accepted result.
   const response=await game.finishSpin();
   if(!response?.result){reason='result-unavailable';break;}
   results.push(response.result);await onResult(response.result,index+1);
   if(response.result.won){reason='jackpot';break;}
  }catch(e){error=e;reason=e.code==='SPIN_STOPPED'?'stopped':'error';break;}
 }
 return {results,requested:count,reason:results.length===count?'complete':reason||'stopped',error};
}
