import {executableMainnetRelease} from '../src/mainnet-release.js';
// Separate opt-in build; default npm build and public hosting stay on devnet.
import {build} from 'esbuild';
import {readFile,writeFile,cp,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readRulesSource,writeRulesSource} from './rules-source.mjs';
import {mainnetPage,pricedDemoHtml} from './mainnet-page.mjs';
import {pageMetadata} from './site-pages.mjs';
import {mainnetGame} from '../src/mainnet-game.js';
import {launchReviewId} from '../src/launch-review-id.js';
import {fingerprintAssets} from './fingerprint-assets.mjs';
const preview=process.argv.slice(2).join(' ')==='--preview';
if(process.argv.length>2&&!preview)throw Error('Use --preview only for a non-executable local preview');
const manifest=JSON.parse(await readFile('config/mainnet.prepared.json'));
if(!preview&&!executableMainnetRelease(manifest))throw Error('Mainnet deployment must be verified before a production build');
const binary=await readFile('artifacts/solana_pot_game.so');
if(binary.length!==manifest.release.binaryBytes||createHash('sha256').update(binary).digest('hex')!==manifest.release.binarySha256)throw Error('Reviewed game binary differs from the release');
if(preview&&executableMainnetRelease(manifest))throw Error('Use the production build for an enabled release');
// Reuse the checked, license-bearing devnet build without changing its output.
await import('./build.mjs');await rm('dist-mainnet',{recursive:true,force:true});await cp('dist','dist-mainnet',{recursive:true});
const sourceReview=await readRulesSource(manifest);await writeRulesSource(sourceReview,'dist-mainnet/fairness');
await cp('web-source/rules.css','dist-mainnet/rules.css');
const html=pageMetadata(mainnetPage(await readFile('web-source/index.html','utf8'),{sourceReview,entryTokens:manifest.entryTokens,consolationTokens:manifest.consolationTokens,orao:manifest.oracleProgram==='VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y'}),manifest.domain,'/');
for(const name of ['index.html','play.html'])await writeFile('dist-mainnet/'+name,html);
await build({entryPoints:['src/mainnet-live.js'],outfile:'dist-mainnet/mainnet-live.js',bundle:true,minify:true,sourcemap:false,format:'esm',platform:'browser',target:'es2022',inject:['src/browser-shim.js'],legalComments:'eof'});
await writeFile('dist-mainnet/mainnet-config.json',JSON.stringify(mainnetGame.config,null,2)+'\n');
// Simulator remains explicitly labelled; its link returns to the current game.
const demo=pricedDemoHtml(await readFile('dist-mainnet/demo.html','utf8'),{entryTokens:manifest.entryTokens,consolationTokens:manifest.consolationTokens}).replace('Play on devnet ↗','Play SolSlot ↗');await writeFile('dist-mainnet/demo.html',demo);
await writeFile('dist-mainnet/release.json',JSON.stringify({network:'solana:mainnet',deployed:executableMainnetRelease(manifest),entriesEnabled:manifest.release.entriesEnabled===true,program:manifest.gameProgram,mint:manifest.mint,binarySha256:manifest.release.binarySha256,launchReviewId:launchReviewId(manifest)})+'\n');
await fingerprintAssets('dist-mainnet');
console.log(preview?'Built a LOCAL mainnet layout preview. Signing remains blocked.':'Built the verified mainnet website.');
