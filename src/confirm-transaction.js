// Confirm the same submitted signature over HTTP without waiting for a fresh
// WebSocket subscription. Unknown/expired responses never trigger a resend.
export async function confirmSubmittedTransaction(connection,{signature,lastValidBlockHeight},{now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=45000}={}){
 const deadline=now()+timeoutMs;let polls=0;
 const read=()=>connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
 const settled=response=>['confirmed','finalized'].includes(response.value[0]?.confirmationStatus);
 const result=response=>({context:response.context,value:{err:response.value[0].err}});
 while(now()<deadline){
  const status=await read();if(settled(status))return result(status);
  if(polls++%4===0&&await connection.getBlockHeight('finalized')>lastValidBlockHeight){
   const final=await read();if(settled(final))return result(final);
   throw Error('Transaction expired or confirmation is unknown; check the saved receipt');
  }
  await sleep(500);
 }
 throw Error('Confirmation is still unknown; check the saved receipt');
}
