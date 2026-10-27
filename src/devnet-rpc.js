// Shared, bounded pacing for the official devnet endpoint. Different read
// methods need not all wait 350ms; repeated methods retain a separate limit.
import { Connection } from '@solana/web3.js';
export function createPacedFetch({fetcher=(...args)=>globalThis.fetch(...args),now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 let tail=Promise.resolve(),nextStart=0,pressureUntil=0;const nextMethod=new Map();
 return async function pacedFetch(url,options) {
  const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});
  await previous;
  try {
   let method;try{method=JSON.parse(options.body).method;}catch{}
   const readOnly=typeof method==='string' && (/^get/.test(method)||['simulateTransaction','isBlockhashValid'].includes(method));
   for(let attempt=0;attempt<3;attempt++){
    options?.signal?.throwIfAborted();
    await sleep(Math.max(0,nextStart-now(),(nextMethod.get(method)??0)-now()));
    options?.signal?.throwIfAborted();
    // Leave headroom for other tabs using the same public endpoint.
    // A rate-limit response slows later calls for a full minute.
    const start=now(),pressured=start<pressureUntil;nextStart=start+(pressured?350:250);nextMethod.set(method,start+(pressured?500:400));
    const response=await fetcher(url,options);
    if(response.status===429)pressureUntil=now()+60000;
    if(response.status!==429 || !readOnly || attempt===2)return response;
    await response.arrayBuffer();
    const header=response.headers.get('retry-after'),seconds=Number(header),date=Date.parse(header);
    const retry=header!==null&&Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-now():0;
    await sleep(Math.max(retry,1000*2**attempt));
   }
  } finally {release();}
 };
}
const pacedFetch=createPacedFetch();
export function devnetConnection() {
 return new Connection('https://api.devnet.solana.com',{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:pacedFetch});
}
