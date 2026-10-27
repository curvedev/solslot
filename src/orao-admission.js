// Read-only admission evidence, separate from accepted-pack settlement. A quiet
// provider is not necessarily offline: allow bounded idle time, but reject a
// recent request that remains unfulfilled beyond the observed normal window.
import bs58 from 'bs58';
import {ORAO_PROGRAM,ORAO_NETWORK,ORAO_FULFILL_DISC,ORAO_REQUEST_DISC,decodeOraoNetwork,decodeOraoRequest} from './orao-vrf.js';
const EVIDENCE_WINDOW_SECONDS=15*60,STALL_SECONDS=120;
export function createOraoAdmission(connection){
 let cachedUntil=0,checking=null;
 return async()=>{
  if(cachedUntil>Date.now())return ORAO_NETWORK;
  if(checking)return checking;
  checking=(async()=>{
   decodeOraoNetwork(await connection.getAccountInfo(ORAO_NETWORK,'confirmed'));
   const rows=await connection.getSignaturesForAddress(ORAO_PROGRAM,{limit:24},'confirmed');
   const now=Math.floor(Date.now()/1000),requests=new Map();let recentFulfillment=false;
   for(const row of rows){
    if(row.err||!row.blockTime||now-row.blockTime>EVIDENCE_WINDOW_SECONDS||row.blockTime>now+30)continue;
    // Unrelated callers can use a newer transaction format. That is not
    // evidence of provider failure; only supported, verified receipts count.
    let tx;try{tx=await connection.getTransaction(row.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});}catch(e){if(e.code===-32015)continue;throw e;}
    if(!tx?.meta||tx.meta.err)continue;
    const msg=tx.transaction.message,keys=msg.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});
    const all=[...(msg.compiledInstructions??msg.instructions),...(tx.meta.innerInstructions??[]).flatMap(x=>x.instructions)];
    for(const ix of all){
     const data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data);
     if(!keys.get(ix.programIdIndex)?.equals(ORAO_PROGRAM))continue;
     const fulfilledIx=data.subarray(0,8).equals(ORAO_FULFILL_DISC),requestIx=data.subarray(0,8).equals(ORAO_REQUEST_DISC);
     if(!fulfilledIx&&!requestIx)continue;
     const indexes=ix.accountKeyIndexes??ix.accounts,request=keys.get(indexes[3]);if(!request)throw Error('Incomplete ORAO health evidence');
     const id=request.toBase58();let result=requests.get(id);
     if(!result){result=decodeOraoRequest(request,await connection.getAccountInfo(request,'confirmed'));requests.set(id,result);}
     if(requestIx&&(data.length!==40||!result.seed.equals(data.subarray(8))))throw Error('ORAO request evidence mismatch');
     if(requestIx&&!result.fulfilled&&now-row.blockTime>STALL_SECONDS)throw Error('Recent ORAO request is stalled; new entries stay paused');
     if(fulfilledIx&&result.fulfilled)recentFulfillment=true;
    }
   }
   if(!recentFulfillment)throw Object.assign(Error('No recent confirmed ORAO fulfillment; new entries stay paused'),{code:'ORAO_IDLE'});
   cachedUntil=Date.now()+15000;return ORAO_NETWORK;
  })().finally(()=>{checking=null});return checking;
 };
}
