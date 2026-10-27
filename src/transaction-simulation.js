// Retry only read-only simulation on lagging RPC nodes. The exact transaction,
// signature checks and minimum context stay unchanged. Never signs or sends.
const lagging=error=>/Minimum context slot has not been reached|BlockhashNotFound|blockhash not found/i.test(String(error?.message??error));
export async function simulateTransactionWithContext(connection,tx,options,{sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 for(let attempt=0;attempt<4;attempt++){
  try{
   const result=await connection.simulateTransaction(tx,options);
   if(result.value.err!=='BlockhashNotFound'||attempt===3)return result;
  }catch(error){if(!lagging(error)||attempt===3)throw error;}
  await sleep(250*(attempt+1));
 }
}
