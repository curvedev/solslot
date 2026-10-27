import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {brotliCompress,gzip,constants} from 'node:zlib';
import {promisify} from 'node:util';
import {extname} from 'node:path';
const br=promisify(brotliCompress),gz=promisify(gzip);
const compressible=new Set(['.html','.js','.css','.svg','.json','.txt','.ttf']);
const reusable=new Set(['.js','.css','.svg','.png','.jpg','.jpeg','.webp','.ttf','.woff2']);
function encoding(header){
 const qualities=new Map(String(header??'').toLowerCase().split(',').map(part=>{
  const [name,...params]=part.trim().split(';');const q=params.find(p=>p.trim().startsWith('q='));
  return [name,q===undefined?1:Number(q.trim().slice(2))];
 }));
 const quality=name=>qualities.get(name)??qualities.get('*')??0;
 return ['br','gzip'].filter(name=>quality(name)>0&&quality(name)<=1).sort((a,b)=>quality(b)-quality(a))[0];
}
// Each request still resolves the public path and checks file metadata. Cache
// only representations, with a byte/entry ceiling and coalesced compression.
export function createStaticAssets({maxBytes=32*1024*1024,maxEntries=64}={}){
 const cache=new Map();let bytes=0;
 function drop(key){const old=cache.get(key);if(old){bytes-=old.bytes;cache.delete(key);}}
 function trim(){while(cache.size>maxEntries||bytes>maxBytes)drop(cache.keys().next().value);}
 return async(path,req,res,type)=>{
  const info=await stat(path);if(!info.isFile())throw Error('Not a file');
  const version=`${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  let entry=cache.get(path);
  if(!entry||entry.version!==version){
   drop(path);entry={version,bytes:0,promise:null};cache.set(path,entry);trim();
   entry.promise=(async()=>{
    const raw=await readFile(path),ext=extname(path);let variants={identity:raw};
    if(compressible.has(ext)&&raw.length>1024){
     const [brotli,gzip]=await Promise.all([br(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4}}),gz(raw)]);
     if(brotli.length<raw.length)variants.br=brotli;if(gzip.length<raw.length)variants.gzip=gzip;
    }
    const result=Object.fromEntries(Object.entries(variants).map(([name,body])=>[name,{body,etag:'"'+createHash('sha256').update(body).digest('base64url')+'"'}]));
    if(cache.get(path)===entry){entry.bytes=Object.values(variants).reduce((sum,b)=>sum+b.length,0);bytes+=entry.bytes;trim();}
    return {variants:result,version:createHash('sha256').update(raw).digest('hex')};
   })().catch(error=>{if(cache.get(path)===entry)drop(path);throw error;});
  }
  const representation=await entry.promise,variants=representation.variants,selected=encoding(req.headers['accept-encoding']),name=variants[selected]?selected:'identity',{body,etag}=variants[name];
  const canReuse=reusable.has(extname(path));
  // Only a URL containing the exact content digest can be immutable. An old,
  // forged or unversioned URL still revalidates; config/API/HTML stay fresh.
  const urlVersions=new URL(req.url,'http://localhost').searchParams.getAll('v');
  const immutable=canReuse&&urlVersions.length===1&&urlVersions[0]===representation.version;
  const headers={'Content-Type':type,'Cache-Control':canReuse?(immutable?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate'):'no-store','Vary':'Accept-Encoding',...(canReuse?{ETag:etag}:{}),...(name!=='identity'?{'Content-Encoding':name}:{})};
  const tags=String(req.headers['if-none-match']??'').split(',').map(tag=>tag.trim().replace(/^W\//,''));
  if(canReuse&&(tags.includes(etag)||tags.includes('*'))){res.writeHead(304,headers);res.end();return;}
  res.writeHead(200,{...headers,'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
 };
}
