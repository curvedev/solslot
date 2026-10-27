import { build } from 'esbuild';
import { cp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { publicDevnetConfig } from '../src/solana-game.js';
import { sitePages } from './site-pages.mjs';

const config = JSON.parse(await readFile('web-source/launch-config.json', 'utf8'));
if (config.mode !== 'demo') throw new Error('Mainnet execution is disabled; use the simulator and separate devnet pages.');
await rm('dist', { recursive: true, force: true });
await cp('web-source', 'dist', { recursive: true });
const pages=sitePages({source:await readFile('web-source/index.html','utf8'),controls:await readFile('web-source/devnet.html','utf8'),domain:config.domain});
for(const [name,html] of Object.entries(pages))await writeFile('dist/'+name,html);
const playgroundBundle=await build({entryPoints:['src/playground-live.js'],outfile:'dist/playground-live.js',bundle:true,minify:true,sourcemap:false,format:'esm',platform:'browser',target:'es2022',inject:['src/browser-shim.js'],legalComments:'eof',metafile:true});
try {
  // Whitelist only public devnet addresses; never bundle a scratch key file.
  const devnet = publicDevnetConfig(JSON.parse(await readFile('config/devnet.local.json','utf8')));
  await writeFile('dist/devnet-config.json',JSON.stringify(devnet,null,2)+'\n');
} catch (error) { if(error.code!=='ENOENT')throw error; }
const discoveryBundle = await build({ entryPoints: ['src/wallet-discovery.js'], outfile: 'dist/wallet-discovery.js', bundle: true, minify: true, sourcemap: false, format: 'esm', target: 'es2022', legalComments: 'eof', metafile: true });
await build({ entryPoints: ['src/playground-scene.js'], outfile: 'dist/scene.js', bundle: true, minify: true, sourcemap: false, format: 'esm', target: 'es2022', legalComments: 'eof' });
const walletBundle = await build({ entryPoints: ['src/devnet-client.js'], outfile: 'dist/devnet-client.js', bundle: true, minify: true, sourcemap: false, format: 'esm', platform: 'browser', target: 'es2022', inject: ['src/browser-shim.js'], legalComments: 'eof', metafile: true });
const roots = new Set();
for (const input of [...Object.keys(walletBundle.metafile.inputs), ...Object.keys(discoveryBundle.metafile.inputs), ...Object.keys(playgroundBundle.metafile.inputs)]) {
  if(input.startsWith('(disabled):'))continue;
  const parts = input.split('/'), i = parts.lastIndexOf('node_modules');
  if (i >= 0) roots.add(parts.slice(0, i + (parts[i + 1].startsWith('@') ? 3 : 2)).join('/'));
}
const notices = ['Third-party notices for the wallet and Playground bundles.\n'];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  notices.push(`\n${pkg.name} ${pkg.version}\nDeclared license: ${pkg.license}\n`);
  for (const file of (await readdir(root)).filter(f => /^(license|notice|copying)(\.|$)/i.test(f))) notices.push(await readFile(root + '/' + file, 'utf8'));
}
await writeFile('dist/WALLET-THIRD-PARTY-NOTICES.txt', notices.join('\n'));
await writeFile('dist/THREE-LICENSE.txt', await readFile('node_modules/three/LICENSE'));
console.log('Built functional devnet Playground, simulator, and advanced wallet controls. Mainnet execution is disabled.');
