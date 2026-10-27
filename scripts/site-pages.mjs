import { Window } from 'happy-dom';
import { playgroundPage } from './playground-page.mjs';

export function pageMetadata(html, domain, path, { demo = false } = {}) {
 const origin=new URL(domain);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.port)throw Error('Use the project HTTPS origin for public page metadata');
 const w=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}}),d=w.document;
 d.write(html);
 const canonical=new URL(path,origin).href;
 let link=d.querySelector('link[rel="canonical"]');
 if(!link){link=d.createElement('link');link.rel='canonical';d.head.append(link);}
 link.href=canonical;
 const description=d.querySelector('meta[name="description"]')?.content??'SolSlot advanced Solana devnet controls. Test funds only; mainnet is disabled.';
 for(const [attribute,name,content] of [
  ['property','og:type','website'],['property','og:site_name','SolSlot'],
  ['property','og:title',d.title],['property','og:description',description],['property','og:url',canonical],
  ['property','og:image',new URL('/assets/solslot-logo.png',origin).href],['property','og:image:alt','SolSlot pink and gold slot-machine logo'],
  ['name','twitter:card','summary'],['name','twitter:site','@playSolSlot'],['name','twitter:title',d.title],['name','twitter:description',description],
  ['name','twitter:image',new URL('/assets/solslot-logo.png',origin).href],
 ]){
  let meta=d.querySelector(`meta[${attribute}="${name}"]`);
  if(!meta){meta=d.createElement('meta');meta.setAttribute(attribute,name);d.head.append(meta);}
  meta.content=content;
 }
 if(demo){const back=d.createElement('a');back.href='./';back.textContent='Play on devnet ↗';d.querySelector('footer').append(back);}
 return '<!doctype html>\n'+d.documentElement.outerHTML;
}

// The default document is the functional test game. Keep the former simulator
// at a distinct URL, while preserving play.html links from existing previews.
export function sitePages({source,controls,domain}) {
 const play=pageMetadata(playgroundPage(source),domain,'/');
 return {
  'index.html':play,
  'play.html':play,
  'demo.html':pageMetadata(source,domain,'/demo.html',{demo:true}),
  'devnet.html':pageMetadata(controls,domain,'/devnet.html'),
 };
}
