// This call cannot request a new entry or ask the player to sign anything.
export async function ensureRevealAvailable(fetcher=fetch){
 const response=await fetcher('/api/devnet/status',{cache:'no-store',signal:AbortSignal.timeout(10000)});
 const status=await response.json();
 if(!response.ok||status.automaticReveal!==true)throw Error('Automatic reveal is offline. Please refresh shortly; no entry was taken.');
 return status;
}
export async function finishDevnetSpin(pending,fetcher=fetch){
 const response=await fetcher('/api/devnet/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending),signal:AbortSignal.timeout(120000)});
 const result=await response.json();
 if(!response.ok)throw Error(result.error||'Automatic reveal is delayed. Retry this same result.');
 return result;
}
