// Unsigned entry drafts and an optional, separately funded devnet-only reveal service.
import { PublicKey } from '@solana/web3.js';
import { AnchorUtils } from '@switchboard-xyz/on-demand';
import { assertDevnet, publicDevnetConfig } from './solana-game.js';
import { draftSpinCommit, draftSpinSettlement } from './solana-oracle.js';
import { encodeInstruction } from './devnet-spin.js';
import { devnetConnection } from './devnet-rpc.js';
import {readJsonBody} from './http-json.js';
let cachedProgram;
const draftConnection=devnetConnection();
export async function createSpinDraft(body, internalServices = {}) {
  const config = publicDevnetConfig(body?.config);
  if (!['commit','settle'].includes(body.action)) throw Error('Choose commit or settle');
  const wallet = new PublicKey(body.wallet);
  const c = draftConnection;
  await assertDevnet(c, { fresh: false });
  const program = await (cachedProgram ??= AnchorUtils.loadProgramFromConnection(c).catch(error=>{cachedProgram=undefined;throw error;}));
  if (program.programId.toBase58() !== config.oracleProgram) throw Error('Oracle program changed');
  // Archive services are process-local arguments; request JSON cannot supply them.
  const ixs = body.action === 'commit' ? await draftSpinCommit(program,c,config,wallet,config.randomness,body.count??1) : await draftSpinSettlement(program,c,config,wallet,internalServices);
  return { unsigned:true, cluster:'solana:devnet', instructions:ixs.map(encodeInstruction) };
}
export function createDevnetApi({ draft = createSpinDraft, settler = null, allowedHosts = ['127.0.0.1:4178','localhost:4178'], allowedOrigins = allowedHosts.map(host=>`http://${host}`) } = {}) {
  let busy = false;
  return async (req,res) => {
    if(req.url==='/api/devnet/status'){
      if(req.method!=='GET'||!allowedHosts.includes(req.headers.host)){res.writeHead(403);res.end();return true;}
      let status={automaticReveal:false,reason:'unconfigured'};
      try{if(settler?.status)status=await settler.status();}catch{status={automaticReveal:false,reason:'network-unavailable'};}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({network:'devnet',automaticReveal:status.automaticReveal===true,reason:status.reason,sessionPayer:settler?.payer??null}));return true;
    }
    if (!['/api/devnet/spin','/api/devnet/settle','/api/devnet/session-spin','/api/devnet/session-receipt'].includes(req.url)) return false;
    const checking=req.url==='/api/devnet/session-receipt',sponsoring=req.url==='/api/devnet/session-spin',settling=checking||sponsoring||req.url==='/api/devnet/settle';
    const send = (status,value) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    // No wildcard CORS, arbitrary RPC URL, or cross-origin access to the configured service.
    if (!allowedHosts.includes(req.headers.host) || !allowedOrigins.includes(req.headers.origin) || new URL(req.headers.origin).host !== req.headers.host) { send(403,{error:'Configured same-origin requests only'});return true; }
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {send(405,{error:'Use JSON POST'});return true;}
    if (!settling && busy) {send(429,{error:'An oracle draft is already being prepared. Try again shortly.'});return true;}
    let ownsLock=false;
    try {
      const body=await readJsonBody(req);
      if(!settling){
        if(busy){send(429,{error:'An oracle draft is already being prepared. Try again shortly.'});return true;}
        busy=true;ownsLock=true;
      }
      if(settling&&!settler)throw Error('Automatic reveal is unavailable. Your accepted spin is preserved.');
      const result = checking ? await settler.receipt(body) : sponsoring ? await settler.sponsor(body) : settling ? await settler.settle(body) : await draft(body);
      send(200,result);
    } catch(error) { send(400,{error:String(error.message || 'Unable to prepare oracle draft').slice(0,240),...(sponsoring&&error.notSubmitted===true?{notSubmitted:true}:{})}); }
    finally {if(ownsLock)busy=false;}
    return true;
  };
}
