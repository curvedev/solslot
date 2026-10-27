import {realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {createDevnetApi} from './devnet-api.js';
import {createStaticAssets} from './static-assets.js';
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.txt':'text/plain','.ttf':'font/ttf','.woff2':'font/woff2'};
function httpsOrigin(value,name){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw Error(`Use an exact HTTPS ${name} without a path`);
 return url.origin;
}
export function serverSettings(env={}){
 const port=Number(env.PORT??4178),host=env.HOST??'127.0.0.1';
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be between 1 and 65535');
 const local=['127.0.0.1','localhost','::1'].includes(host);
 let origins=local?[`http://127.0.0.1:${port}`,`http://localhost:${port}`]:[];
 if(env.SOLPOT_PUBLIC_ORIGIN)origins=[httpsOrigin(env.SOLPOT_PUBLIC_ORIGIN,'SOLPOT_PUBLIC_ORIGIN')];
 if(!origins.length)throw Error('Set SOLPOT_PUBLIC_ORIGIN before exposing the server');
 const redirectOrigins=env.SOLPOT_REDIRECT_ORIGINS?Array.from(new Set(env.SOLPOT_REDIRECT_ORIGINS.split(',').map(value=>httpsOrigin(value.trim(),'SOLPOT_REDIRECT_ORIGINS')))):[];
 if(redirectOrigins.length&&!env.SOLPOT_PUBLIC_ORIGIN)throw Error('Set SOLPOT_PUBLIC_ORIGIN before configuring redirect origins');
 if(redirectOrigins.some(origin=>origins.includes(origin)))throw Error('Redirect origins must differ from SOLPOT_PUBLIC_ORIGIN');
 return {port,host,origins,redirectOrigins};
}
export function createHandler({root=resolve('dist'),origins=['http://127.0.0.1:4178','http://localhost:4178'],redirectOrigins=[],api,settler=null,health={status:'ok',network:'devnet',mainnetEnabled:false}}={}){
 root=resolve(root);
 const serveAsset=createStaticAssets();
 const primary=redirectOrigins.length?httpsOrigin(origins[0],'canonical origin'):null;
 const aliasHosts=new Set(redirectOrigins.map(origin=>{httpsOrigin(origin,'redirect origin');if(origins.includes(origin))throw Error('Redirect origins must differ from the canonical origin');return new URL(origin).host;}));
 const httpsHosts=new Set([...origins,...redirectOrigins].filter(origin=>new URL(origin).protocol==='https:').map(origin=>new URL(origin).host));
 const helper=api??createDevnetApi({settler,allowedOrigins:origins,allowedHosts:origins.map(o=>new URL(o).host)});
 return async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  // The HTTPS edge may connect over HTTP internally. Bind this header to the
  // exact configured Host only; never trust client-supplied forwarded headers.
  if(httpsHosts.has(req.headers.host))res.setHeader('Strict-Transport-Security','max-age=86400');
  try{
   const readOnly=['GET','HEAD'].includes(req.method),requestPath=new URL(req.url,'http://localhost').pathname;
   if(readOnly&&requestPath==='/healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:JSON.stringify(health));return;}
   if(readOnly&&aliasHosts.has(req.headers.host)&&!requestPath.startsWith('/api/')){
    // Concatenating a fixed origin preserves path/query without allowing a
    // protocol-relative or absolute request target to select another host.
    if(!req.url.startsWith('/')||/[\u0000-\u0020\u007f]/.test(req.url))throw Error('Invalid redirect path');
    res.writeHead(308,{'Location':primary+req.url,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:'Redirecting to the project site');return;
   }
   if(await helper(req,res))return;
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end('Method not allowed');return;}
   const pathname=decodeURIComponent(requestPath);
   if(pathname.split('/').some(part=>part.startsWith('.')))throw Error('Private path');
   const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
   const publicRoot=await realpath(root);
   if(!path.startsWith(root+sep)||!(await realpath(path)).startsWith(publicRoot+sep))throw Error('Outside public directory');
   await serveAsset(path,req,res,types[extname(path)]??'application/octet-stream');
  }catch{res.writeHead(404);res.end('Not found');}
 };
}
