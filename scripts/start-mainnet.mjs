import {executableMainnetRelease} from '../src/mainnet-release.js';
// Linux kernel lock survives process crashes safely: only one ledger owner runs.
// Never fall back to an unlocked worker if flock is unavailable.
import {spawn} from 'node:child_process';
import {lstatSync} from 'node:fs';
import manifest from '../config/mainnet.prepared.json' with {type:'json'};
if(process.getuid?.()!==1000)throw Error('Mainnet service must run as the unprivileged node user');
if(!executableMainnetRelease(manifest))throw Error('Mainnet release is not verified');
const runtime='/var/lib/solpot/solslot-mainnet';
if(process.env.SOLPOT_MAINNET_RELAYER_KEYPAIR!==runtime+'/automation.json'||process.env.SOLPOT_MAINNET_RELAYER_STATE!==runtime+'/ledger.json')throw Error('Use the dedicated mounted mainnet runtime paths');
if(process.env.RAILWAY_VOLUME_MOUNT_PATH!=='/var/lib/solpot')throw Error('Mainnet requires its durable volume');
if(Object.keys(process.env).some(k=>k.startsWith('SOLPOT_DEVNET_RELAYER_')))throw Error('Remove the devnet worker settings before starting the mainnet worker');
const dir=lstatSync(runtime);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0)throw Error('Use a private regular runtime directory');
const lock=runtime+'/worker.lock';
try{const st=lstatSync(lock);if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid lock file')}catch(e){if(e.code!=='ENOENT')throw e;}
process.umask(0o077);
const child=spawn('flock',['--exclusive','--nonblock','--no-fork',lock,process.execPath,'scripts/serve-mainnet.mjs'],{stdio:'inherit',env:{...process.env,SOLPOT_MAINNET_LOCKED:'1'}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{console.error('Mainnet worker lock could not be acquired. No unlocked fallback is allowed.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
