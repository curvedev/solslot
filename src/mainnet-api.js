// Exact same-origin mainnet endpoints. Public requests can draft a spin or
// settle an already accepted reference; they cannot request transfers or admin actions.
import {mainnetGame} from './mainnet-game.js';
import {createMainnetDraftService} from './mainnet-draft.js';
import {readJsonBody} from './http-json.js';
export function createMainnetApi({game=mainnetGame,draft=createMainnetDraftService({game}),settler=null,origins=['https://solslot.fun']}={}){
 const hosts=origins.map(x=>new URL(x).host);let preparing=false;
 return async(req,res)=>{
  if(!['/api/mainnet/status','/api/mainnet/spin','/api/mainnet/settle'].includes(req.url))return false;
  const send=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  if(!hosts.includes(req.headers.host)){send(403,{error:'Unknown project host'});return true;}
  if(req.url==='/api/mainnet/status'){
   if(req.method!=='GET'){send(405,{error:'Use GET'});return true;}
   const status=settler?await settler.status().catch(()=>({automaticReveal:false,reason:'unavailable'})):{automaticReveal:false,reason:'not-deployed'};
   send(200,{network:'mainnet-beta',...status,sessionPayer:null});return true;
  }
  if(req.method!=='POST'||req.headers['content-type']!=='application/json'){send(405,{error:'Use JSON POST'});return true;}
  if(!origins.includes(req.headers.origin)||new URL(req.headers.origin).host!==req.headers.host){send(403,{error:'Use the project website'});return true;}
  if(req.url==='/api/mainnet/spin'&&preparing){send(429,{error:'A spin is being prepared; retry shortly'});return true;}
  const drafting=req.url==='/api/mainnet/spin';let ownsLock=false;
  try{
   const body=await readJsonBody(req);
   if(drafting){
    if(preparing){send(429,{error:'A spin is being prepared; retry shortly'});return true;}
    preparing=true;ownsLock=true;
   }
   if(drafting){
    game.publicConfig(body.config);
    if(body.action==='commit'){
     if(!settler)throw Error('Automatic settlement is unavailable');
     let state=await settler.status();
     if(!state.automaticReveal&&state.canPrepareSpin&&body.allowOracleProbe===true){await settler.ensureEntryOracle(body);state=await settler.status();}
     if(state.automaticReveal!==true)throw Error('New spins are paused while automatic settlement is unavailable');
    }
    send(200,await draft(body));
   }
   else{if(!settler)throw Error('Automatic settlement is unavailable; your accepted spin is preserved');send(200,await settler.settle(body));}
  }catch{send(400,{error:'Unable to complete this request. Refresh the on-chain state; an accepted spin is never rerolled.'});}
  finally{if(ownsLock)preparing=false;}
  return true;
 };
}
