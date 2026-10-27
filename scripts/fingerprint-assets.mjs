// Version only static resources. Configuration, release and API URLs stay fresh.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function fingerprintAssets(root){
 root=resolve(root);const files=(await readdir(root)).filter(f=>/\.(?:html|css|js)$/.test(f));
 const hashes=new Map();
 async function version(value){
  if(!value.startsWith('./')||/[?#]/.test(value))return value;
  const path=resolve(root,value);
  if(!path.startsWith(root+sep))throw Error('Asset outside public root');
  let hash=hashes.get(path);if(!hash){hash=sha(await readFile(path));hashes.set(path,hash);}
  return value+'?v='+hash;
 }
 async function replace(source,pattern){
  const matches=[...source.matchAll(pattern)];
  const replacements=await Promise.all(matches.map(async m=>[m.index,m[0],m[0].replace(m[1],await version(m[1]))]));
  for(const [index,before,after]of replacements.reverse())source=source.slice(0,index)+after+source.slice(index+before.length);
  return source;
 }
 // Binary assets do not depend on CSS/JS, so their versions are stable first.
 for(const name of files.filter(f=>['.css','.js'].includes(extname(f)))){
  const path=resolve(root,name),before=await readFile(path,'utf8');
  const after=await replace(before,/["'(](\.\/assets\/[^"'()\s?]+\.(?:webp|png|jpe?g|svg|woff2|ttf))["')]/g);
  if(after!==before)await writeFile(path,after);
 }
 // Hash final styles and bundles, after their image/font URLs were rewritten.
 hashes.clear();
 for(const name of files.filter(f=>f.endsWith('.html'))){
  const path=resolve(root,name),before=await readFile(path,'utf8');
  const after=await replace(before,/(?:src|href)="(\.\/[^"?#]+\.(?:js|css|webp|png|jpe?g|svg|woff2|ttf))"/g);
  if(after!==before)await writeFile(path,after);
 }
}
