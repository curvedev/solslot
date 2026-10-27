import { PublicKey } from '@solana/web3.js';
import { playSpinBatch } from './spin-batch.js';
import { devnetConnection } from './devnet-rpc.js';
import { createPlaygroundGame, receiptResults } from './playground-game.js';
import { standardWallets, watchStandardWallets, injectedWallets } from './wallet-discovery.js';
import { connectStandardDevnetWallet } from './standard-devnet-wallet.js';
import { createJackpotWorld } from './playground-scene.js';
import { initPlaygroundLayout } from '../web-source/layout.js';
import { createGameAudio } from '../web-source/audio.js';
import { outcomeSymbols, SYMBOLS } from '../web-source/symbols.js';
import {createMainnetLaunchWatch,launchPresentation} from './mainnet-launch-status.js';

export function bootPlayground({mainnet=false,connectWalletAdapter=connectStandardDevnetWallet,makeGame=createPlaygroundGame,connection=devnetConnection(),configUrl='./devnet-config.json'}={}) {
const net=(test,live)=>mainnet?live:test;
const token=mainnet?'SLOT':'test SLOT',sol=mainnet?'SOL':'test SOL',tokens=mainnet?'tokens':'test tokens';
const $=id=>document.getElementById(id),num=n=>Number(n).toLocaleString('en-US');
const units=(n,d=6)=>{const scale=10n**BigInt(d),rest=(n%scale).toString().padStart(d,'0').replace(/0+$/,'');return (n/scale).toLocaleString('en-US')+(rest?'.'+rest:'');};
let launchStatus=null,initializing=false;
let walletNotice="",game=null,provider=null,registered=null,unsubscribe=()=>{},pack=1,animating=false,running=false,connecting=false,recovering=false,pageActive=true,batch=null,history=[],motion=!matchMedia('(prefers-reduced-motion: reduce)').matches;

function message(title,detail='') {$('result-title').textContent=title;$('result-detail').textContent=detail;}
const world=createJackpotWorld($('jackpot-world'),()=>void play());world.setStyle('playground');world.setMotion(motion);world.setEnabled(false);
const audio=createGameAudio({onChange:()=>renderAudio()});
function renderAudio(){const s=audio.status();for(const [id,on,label]of [['music-toggle',s.music,'Music'],['effects-toggle',s.effects,'Sound']]){$(id).setAttribute('aria-pressed',String(on));$(id).querySelector('span').textContent=label+(on?' on':' off');$(id).disabled=!s.available;}}
renderAudio();$('music-toggle').onclick=()=>audio.toggleMusic();$('effects-toggle').onclick=()=>audio.toggleEffects();
function render(){
 const v=game?.view(),s=v?.snapshot?.state,p=provider?.publicKey?v?.snapshot?.playerState:null,connected=!!provider?.publicKey,busy=!!v?.busy||animating||running||connecting||recovering;
 const ownPending=!!(s?.pending&&provider?.publicKey?.equals(s.pending.player));
 const credits=p?s?Number(p.prepaid/s.entry):0:0;
 const entry=s?Number(s.entry)/1e6:Number(document.body.dataset.entryTokens||200000);
 const noFeeFunds=connected&&!v?.sessionReady&&v?.snapshot?.solBalance===0n;
 const missingTokens=connected&&s&&!ownPending&&!credits&&v.snapshot.balance<s.entry*BigInt(pack);
 const fundingNote=noFeeFunds?net('This address needs free DEVNET SOL for test transaction fees. Real SOL and Testnet funds do not work here.','This address needs SOL on Solana mainnet for transaction fees.'):missingTokens?net(`This address needs ${num(pack*entry)} test SLOT for this pack. Mainnet tokens do not work in the test game.`,`This pack needs ${num(pack*entry)} SLOT in this wallet.`):'';
 $('wallet-label').textContent=provider?.viewOnly?'Reconnect wallet':connected?provider.publicKey.toBase58().slice(0,4)+'…'+provider.publicKey.toBase58().slice(-4):'Connect wallet';
 $('wallet-button').disabled=busy;$('disconnect-button').hidden=!provider;$('disconnect-button').disabled=busy;
 for(const b of document.querySelectorAll('#wallet-dialog .provider-button'))b.disabled=busy||b.dataset.unavailable==='true';
 $('chain-refresh').disabled=busy;$('chain-receipt').hidden=!v?.receipt;$('chain-receipt').disabled=busy;
 $('network-status').textContent=v?.receipt?'Transaction submitted · check confirmation':s?`Confirmed at slot ${v.snapshot.slot} · ${s.closed?'game closed':net('test game open','game open')}`:'Loading chain state…';
 $('machine-jackpot').textContent=s?units(s.pot+(s.pending?.lockedPot??0n),9):'—';
 if(s){world.setPot(Number(s.pot+(s.pending?.lockedPot??0n))/1e9,net('TEST SOL','SOL'),net('NO CASH VALUE','SOLANA MAINNET'),net('devnet','mainnet'),units(s.pot+(s.pending?.lockedPot??0n),9));}
 $('machine-quote-label').textContent=net('No cash value','Solana mainnet');
 for(const id of ['total-burned','machine-total-burned','summary-burned'])$(id).textContent=s?units(s.burned):'—';
 if(walletNotice)$('wallet-status').textContent=walletNotice;else if(connected&&v?.snapshot)$('wallet-status').textContent=`${provider.viewOnly?'Viewing':'Connected'}: ${provider.publicKey.toBase58()} · ${units(v.snapshot.solBalance,9)} ${net('DEVNET SOL','SOL')} · ${units(v.snapshot.balance)} ${token}. ${fundingNote||net('Ready to use test funds.','Ready to play.')}`;
 const balance=connected&&v?.snapshot?units(v.snapshot.balance):'—';$('balance').textContent=balance+' $SLOT';$('summary-balance').textContent=balance;
 $('summary-spins').textContent=String(history.length);$('summary-prepaid').textContent=connected?String(credits):'—';
 for(const id of ['summary-claimable','reward-balance'])$(id).textContent=connected?units(p?.tokenRewards??0n):'—';
 $('summary-sol-paid').textContent=connected?units(p?.solRewards??0n,9):'—';
 const claimable=!!(p&&(p.tokenRewards>0n||p.solRewards>0n));
 for(const id of ['claim-rewards','summary-claim']){$(id).disabled=busy||!!provider?.viewOnly||!claimable||!!v?.receipt;$(id).textContent=claimable?'Claim rewards ↗':'Nothing to claim yet';}
 $('summary-reward-note').textContent=connected?'Earned tokens and SOL are saved here until claimed.':'Connect to see your on-chain rewards.';
 $('reward-claimed').textContent=connected?`${units(p?.solRewards??0n,9)} ${sol} ready to claim.`:'Connect to view your rewards.';
 $('held-entry').hidden=!ownPending;$('held-entry').textContent=`${num((s?.pending?.count??1)*entry)} ${tokens} committed. The accepted results finish automatically.`;
 $('play-button').disabled=busy||!game||!!v?.receipt||(!ownPending&&noFeeFunds)||missingTokens||(connected&&(!s||(!ownPending&&(s.closed||!!s.pending||s.pot===0n))));
 world.setEnabled(!$('play-button').disabled);
 $('spin-button-title').textContent=busy?({preparing:'PREPARING…',wallet:'APPROVE IN WALLET',confirming:'CONFIRMING…',revealing:'REVEALING…'}[v?.phase]||'SPINNING…'):!connected||provider?.viewOnly?'CONNECT WALLET':ownPending?'FINISH SPIN':fundingNote?net('TEST FUNDS NEEDED','FUNDS NEEDED'):credits>1?`PLAY ${Math.min(10,credits)} SPINS`:credits||pack===1?'SPIN':`BUY ${pack} & PLAY`;
 $('spin-button-cost').textContent=batch?batch.settling?`Confirming ${batch.count===1?'spin':'pack'}…`:`Spin ${batch.index} of ${batch.count}`:ownPending?'No new entry or wallet approval':credits?(v?.sessionReady?'Prepaid · no wallet popup':`${credits} prepaid · approve once`):`${num(pack*entry)} ${mainnet?'':'test '}$SLOT`;
 $('spin-button-icon').textContent=busy?'↻':'ϟ';$('play-button').setAttribute('aria-busy',String(busy));
 $('pack-status').textContent=batch?`${batch.settling?'Confirming the pack':`Spin ${batch.index} of ${batch.count}`} · ${batch.stopRequested?'Skipping animations. Accepted results still finish.':'One wait, then back-to-back spins.'}`:!connected?net('Connect your wallet on Devnet to play with test tokens.','Connect your wallet on Solana mainnet to play.'):ownPending?'Your accepted result finishes automatically. No second wallet approval.':fundingNote?fundingNote:s?.pending?'Another spin is pending. Refresh shortly.':s?.closed?'New spins are stopped. Rewards and unused credits remain withdrawable.':credits?`${credits} prepaid ${credits===1?'spin':'spins'} ready. ${v?.sessionReady?'Play them back to back — no wallet approvals.':'Approve once to play the remaining spins automatically.'}`:`${pack===1?'One spin':`Play ${pack} spins back to back`}. ${pack>1?'Approve once. Results appear together at the end.':'One wallet approval; reveal is automatic.'}`;
 $('prepaid-actions').hidden=false;$('prepaid-actions').classList.toggle('is-empty',!credits&&!batch);$('prepaid-actions').inert=!credits&&!batch;$('prepaid-actions').setAttribute('aria-hidden',String(!credits&&!batch));$('pack-credits').textContent=String(credits);$('pack-withdraw').disabled=busy||!!provider?.viewOnly||!credits||!!v?.receipt;
 for(const b of document.querySelectorAll('[data-pack]')){b.disabled=busy||credits>0||ownPending;b.setAttribute('aria-pressed',String(Number(b.dataset.pack)===pack));}
 $('batch-stop').disabled=!batch||batch.stopRequested;$('batch-stop').textContent=batch?.stopRequested?'Skipping…':'Skip animations';
 if(mainnet&&launchStatus?.automaticReveal!==true&&launchStatus?.canPrepareSpin!==true&&!ownPending&&!busy){
  const waiting=launchPresentation(launchStatus);
  // Connecting is useful before launch. Keep availability separate from the
  // wallet action, while continuing to block every unverified paid spin.
  $('play-button').disabled=connected&&!provider?.viewOnly;world.setEnabled(!$('play-button').disabled);
  $('spin-button-title').textContent=!connected||provider?.viewOnly?'CONNECT WALLET':waiting.title==='SPIN'?(pack===1?'SPIN':`BUY ${pack} & PLAY`):waiting.title;
  $('pack-status').textContent=waiting.detail;$('network-status').textContent=waiting.detail;
  if(!s){$('machine-jackpot').textContent='0';world.setPot(0,'SOL','AWAITING LAUNCH','mainnet','0');}
 }
 $('session-totals').textContent=`${history.length} confirmed ${history.length===1?'spin':'spins'} shown in this tab`;
}
function viewerKey(){const c=game?.view().config;return c?`solpot:viewer:${c.gameProgram}:${c.mint}`:null;}
function rememberViewer(address){const key=viewerKey();if(!key)return;try{if(address)sessionStorage.setItem(key,address);else sessionStorage.removeItem(key);}catch{}}
async function restoreViewer(){
 let address;try{address=sessionStorage.getItem(viewerKey());}catch{}if(!address)return false;
 provider={publicKey:new PublicKey(address),viewOnly:true};game.setWallet(provider);await game.refresh();$('summary-rewards-tab').click();message('Your rewards are up to date.','Spins are stopped. Reconnect your wallet to play or claim; unused credits remain available.');await resumePending();render();return true;
}
function batchKey(){const c=game?.view().config;return provider?.publicKey?`solpot:batch:${c?.gameProgram}:${c?.mint}:${provider.publicKey.toBase58()}`:null;}
function batchMarker(value){try{const key=batchKey();if(!key)return false;if(value===true)sessionStorage.setItem(key,'stopped-on-reload');else if(value===false)sessionStorage.removeItem(key);return !!sessionStorage.getItem(key);}catch{return false;}}
function stopBatch(){if(batch)batch.stopRequested=true;render();}
function recordResult(result){if(!history.some(r=>r.id===result.id))history.push(result);renderHistory();}
async function animateResult(result){animating=true;render();await audio.unlock();audio.effect('spin',motion);try{await world.spin(result,{quick:true,onReelStop:index=>audio.effect('reel-stop',motion,index)});if(motion&&pageActive&&!batch?.stopRequested)await new Promise(resolve=>setTimeout(resolve,450));}catch{}finally{audio.stopSpin();animating=false;}}
async function run(action,count=1,{quiet=false}={}) {
 if(!game||running||animating||game.view().busy)return;
 const chosen=provider,who=provider?.publicKey?.toBase58(),sameWallet=()=>provider===chosen&&provider?.publicKey?.toBase58()===who;
 running=true;
 try {
  if(action==='spin'){
   const v=game.view(),credits=Number((v.snapshot.playerState?.prepaid??0n)/v.snapshot.state.entry),total=credits?Math.min(10,credits):count;
   batch={count:total,index:1,stopRequested:false,settling:true};const current=batch;batchMarker(true);render();
   message(total>1?`Starting ${total} spins…`:'Preparing your spin…',v.sessionReady?'Your prepaid spins will play automatically.':'Approve once in your wallet to start.');
   const result=await playSpinBatch({game,count:total,purchaseCount:count,shouldContinue:()=>pageActive&&sameWallet()&&!current.stopRequested,
    onProgress:progress=>{current.index=progress.index;current.settling=!!progress.settling;if(pageActive&&sameWallet()){render();message(progress.settling?`Confirming ${total===1?'your spin':'your pack'}…`:`Spin ${progress.index} of ${total}…`,progress.settling?'One wait for all accepted results.':'All results are confirmed.');}},
    onSettled:results=>{if(sameWallet())for(const value of results)recordResult(value);},
    onResult:async value=>{if(!sameWallet())return;recordResult(value);if(pageActive)await animateResult(value);}});
   if(pageActive&&sameWallet()){
    batchMarker(false);
    if(result.results.length){if(total>1)presentBatch(result);else present(result.results[0]);}
    else message(result.error?.message??'Spins stopped.','No further spins will start. Any accepted entry still finishes; unused credits remain available.');
   }
  }else{
   render();message(action==='finish'?'Finishing your accepted spin…':'Preparing your transaction…',action==='finish'?'No new entry or wallet approval.':'Approve this action in your wallet.');
   const response=action==='finish'?await game.finishSpin():await game.act(action,count);
   if(!sameWallet()||!pageActive)return;
   if(response?.cancelled){message('Cancelled.','No transaction was submitted.');return;}
   if(response.results?.length){for(const result of response.results)recordResult(result);if(!quiet)presentBatch({results:response.results,requested:response.requested??response.results.length,reason:response.results.some(r=>r.won)?'jackpot':'complete'});}
   else if(response.result){recordResult(response.result);if(!quiet){await animateResult(response.result);present(response.result);}}
   else{const messages={claim:'Rewards sent to your wallet.',refund:'Unused prepaid tokens returned.'};message(messages[action]??'Spin settled. Your balances are updated.');}
  }
 }catch(e){if(sameWallet()&&pageActive)message(String(e.message).slice(0,300),'An accepted spin stays on chain. No further entries will start.');}
 finally{running=false;animating=false;batch=null;if(pageActive)render();}
}
function warmSelectedPack(){if(pageActive&&!document.hidden&&!running&&!animating&&!recovering&&provider?.publicKey&&!provider.viewOnly)void game?.warmSpin?.(pack);}
async function play(){if(!provider?.publicKey||provider?.viewOnly){$('wallet-dialog').showModal();refreshWallets();return;}const s=game?.view().snapshot;if(!s||recovering)return;if(mainnet&&launchStatus?.automaticReveal!==true&&launchStatus?.canPrepareSpin!==true&&!s.state.pending){const waiting=launchPresentation(launchStatus);message(waiting.title,waiting.detail);return;}return run(s.state.pending?'finish':'spin',pack);}
async function resumePending(){
 if(!provider?.publicKey||recovering||running||game?.view().busy)return;
 const chosen=provider,who=provider.publicKey.toBase58(),active=()=>pageActive&&provider===chosen&&provider?.publicKey?.toBase58()===who;
 let v=game.view(),interrupted=batchMarker();
 for(const result of receiptResults(v.snapshot?.playerState?.receipt,v.snapshot?.state))recordResult(result);
 if(!v.receipt&&!v.snapshot?.state.pending?.player.equals(provider.publicKey)&&!interrupted)return;
 recovering=true;render();
 try{
  $('summary-rewards-tab').click();
  // Reconcile saved submissions only. This path never calls act('spin').
  if(v.receipt){
   for(let attempt=0;attempt<10;attempt++){
    if(!active())return;
    try{await game.checkReceipt();break;}
    catch(error){if(attempt===9)throw error;message('Spins stopped. Checking the last transaction.','Your confirmed rewards remain visible. No new entry will start.');await new Promise(resolve=>setTimeout(resolve,3000));}
   }
   if(!active())return;v=game.view();
  }
  if(v.snapshot?.state.pending?.player.equals(provider.publicKey)){await run('finish',1,{quiet:true});if(!active())return;}
  await game.refresh();if(!active())return;
  for(const result of receiptResults(game.view().snapshot?.playerState?.receipt,game.view().snapshot?.state))recordResult(result);
  if(!game.view().receipt&&!game.view().snapshot?.state.pending?.player.equals(provider.publicKey)){
   batchMarker(false);message('Spins stopped. Your rewards are up to date.','Animations are skipped. Accepted pack results are saved in Rewards; any unused credits remain refundable.');
  }
 }catch(e){if(active())message('Spins stopped. Checking the last transaction.',`${e.message} Your confirmed rewards remain visible; use Check transaction or Refresh to finish checking.`);}
 finally{recovering=false;if(pageActive)render();}
}
function presentBatch({results,requested,reason,error}){
 const dialog=$('outcome-dialog'),won=results.some(r=>r.won),tokens=results.reduce((sum,r)=>sum+r.reward,0),sol=results.reduce((sum,r)=>sum+r.payout,0),burned=results.reduce((sum,r)=>sum+r.burn,0),v=game.view();
 const solText=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:9});
 const credits=Number((v.snapshot.playerState?.prepaid??0n)/v.snapshot.state.entry);
 dialog.dataset.tier=won?'jackpot':tokens?'consolation':'loss';dialog.dataset.preview='false';dialog.dataset.batch='true';
 $('outcome-symbols').hidden=true;$('batch-results').hidden=false;$('batch-results').replaceChildren();
 $('outcome-eyebrow').textContent=`${results.length} OF ${requested} SPINS · CONFIRMED ON ${net('DEVNET','SOLANA')}`;
 $('outcome-title').textContent=reason==='complete'?'Your pack results':won?'Jackpot!':'Your spins so far';
 const rewards=[...(tokens?[`${num(tokens)} ${mainnet?'SLOT':'test SLOT'}`]:[]),...(sol?[`${solText(sol)} ${mainnet?'SOL':'test SOL'}`]:[])];
 $('outcome-amount').textContent=rewards.join(' + ')||'No rewards this round';
 $('outcome-usd').textContent=`${num(burned)} ${mainnet?'tokens burned':'test tokens burned · No cash value'}`;
 for(const [index,r]of results.entries()){
  const row=document.createElement('li');row.dataset.tier=r.won?'jackpot':r.reward?'consolation':'loss';
  const order=document.createElement('span');order.className='batch-order';order.textContent=String(index+1).padStart(2,'0');order.setAttribute('aria-label',`Spin ${index+1}`);
  const symbols=document.createElement('span');symbols.className='batch-symbols';symbols.setAttribute('aria-hidden','true');
  for(const symbol of outcomeSymbols(r.number)){const img=document.createElement('img');img.src=SYMBOLS[symbol].image;img.alt='';symbols.append(img);}
  const label=document.createElement('span');label.className='batch-result-name';label.textContent=r.won?'Jackpot':r.reward?(r.burn===0?'Entry back':'Half back'):'No match';
  const reward=document.createElement('strong');reward.className='batch-reward';reward.textContent=r.won?`${solText(r.payout)} ${mainnet?'SOL':'test SOL'}`:r.reward?`${num(r.reward)} ${mainnet?'SLOT':'test SLOT'}`:'—';row.append(order,symbols,label,reward);$('batch-results').append(row);
 }
 const note=reason==='complete'?'All spins finished. Rewards are saved to claim.':reason==='jackpot'?'The jackpot stopped the remaining spins.':error?String(error.message).slice(0,180):'The sequence stopped. No more entries will start.';
 $('outcome-detail').textContent=`${note}${credits?` ${credits} unused ${credits===1?'credit remains':'credits remain'} available.`:''}`;
 $('outcome-action').textContent='Back to the machine';message($('outcome-title').textContent,$('outcome-detail').textContent);
 if(dialog.open)dialog.close();dialog.showModal();audio.effect(won?'jackpot':tokens?'consolation':'loss');
}
function present(r){
 $('outcome-dialog').dataset.batch='false';$('outcome-symbols').hidden=false;$('batch-results').hidden=true;
 message(r.won?'Jackpot!':r.reward?(r.burn===0?'Entry back.':'Half back.'):'No match this time.',`${num(r.burn)} ${tokens} burned. ${r.won?'Your SOL prize is ready to claim.':r.reward?`${num(r.reward)} ${tokens} are ready to claim.`:net('The test jackpot carries over.','The jackpot carries over.')}`);
 const tier=r.won?'jackpot':r.reward?'consolation':'loss',dialog=$('outcome-dialog');dialog.dataset.tier=tier;dialog.dataset.preview='false';
 $('outcome-eyebrow').textContent=net('CONFIRMED ON SOLANA DEVNET','CONFIRMED ON SOLANA');$('outcome-title').textContent=r.won?'Jackpot!':r.reward?(r.burn===0?'Entry back.':'Half back.'):'No match.';
 $('outcome-amount').textContent=r.won?`${r.payout} ${sol}`:r.reward?`${num(r.reward)} ${mainnet?'':'test '}$SLOT`:`${num(r.burn)} tokens burned`;
 $('outcome-detail').textContent=$('result-detail').textContent;$('outcome-usd').textContent=net('Test funds have no cash value.','Rewards are saved on chain until claimed.');$('outcome-action').textContent='Back to the machine';
 $('outcome-symbols').replaceChildren(...outcomeSymbols(r.number).map(i=>{const img=document.createElement('img');img.src=SYMBOLS[i].image;img.alt=SYMBOLS[i].label;return img;}));
 if(dialog.open)dialog.close();dialog.showModal();audio.effect(tier);
}
function renderHistory(){const body=$('activity-body');body.replaceChildren();for(const r of [...history].reverse()){const row=document.createElement('tr');for(const text of ['#'+r.id,r.won?'Jackpot':r.reward?(r.burn===0?'Entry back':'Half back'):'No match',String(r.number),num(r.burn)+' '+tokens,num(r.reward)+' '+tokens,r.payout+' '+sol]){const td=document.createElement('td');td.textContent=text;row.append(td);}body.append(row);}}
function detach(){stopBatch();unsubscribe();unsubscribe=()=>{};provider?.dispose?.();provider=null;registered=null;history=[];renderHistory();game?.setWallet(null);render();}
function attach(p,wallet=null){detach();provider=p;registered=wallet;let address='';const changed=()=>{const next=p.publicKey?.toBase58()??'';if(next===address)return;stopBatch();address=next;rememberViewer(next);history=[];renderHistory();game?.setWallet(p);game?.refresh().then(async()=>{await resumePending();warmSelectedPack();}).catch(e=>message(e.message));$('wallet-status').textContent=next?net('Connected on devnet. Choose an action on the machine.','Connected on Solana mainnet.'):net('Wallet disconnected. Select Devnet and reconnect.','Wallet disconnected. Select Mainnet and reconnect.');render();};
 if(p.subscribe)unsubscribe=p.subscribe(changed);else{p.on?.('accountChanged',changed);p.on?.('disconnect',changed);unsubscribe=()=>{p.removeListener?.('accountChanged',changed);p.removeListener?.('disconnect',changed);};}changed();$('wallet-dialog').close();
}
async function connectWallet(connect, wallet = null) {
 if(connecting||game?.view().busy)return;
 connecting=true;walletNotice='Choose an account in your wallet. Connecting does not request a transaction.';render();
 try { const next=await connect();walletNotice='';attach(next,wallet); }
 catch(e) { walletNotice=e.message; }
 finally { connecting=false;render(); }
}
function refreshWallets(){
 const wallets=standardWallets();if(registered&&!wallets.includes(registered))detach();
 const legacy=injectedWallets(window,wallets);
 const choices=[...wallets.map(wallet=>({name:wallet.name,icon:wallet.icon,connect:()=>connectWallet(()=>connectWalletAdapter(wallet),wallet)})),
  ...legacy.filter(w=>!w.id).map(w=>({name:w.name,connect:()=>connectWallet(async()=>{await w.provider.connect();return w.provider;})}))];
 $('standard-wallets').replaceChildren(...choices.sort((a,b)=>a.name.localeCompare(b.name)).map(wallet=>{
  const b=document.createElement('button');b.type='button';b.className='provider-button';b.setAttribute('aria-label','Connect '+wallet.name);
  if(/^data:image\/(png|svg\+xml|webp|jpeg);base64,/.test(wallet.icon??'')){const icon=document.createElement('img');icon.className='wallet-icon';icon.src=wallet.icon;icon.alt='';b.append(icon);}
  const name=document.createElement('span');name.className='wallet-name';name.textContent=wallet.name;
  const hint=document.createElement('span');hint.className='wallet-hint';hint.textContent='Detected ↗';b.append(name,hint);b.onclick=wallet.connect;return b;
 }));
 $('standard-wallet-note').textContent=wallets.length||legacy.length?net('Choose a detected wallet. This test game uses Devnet.','Choose a detected Solana wallet. This game uses mainnet.'):'No Solana wallet detected in this browser. Open this page in the browser where your wallet is installed and allow it on this site.';
 for(const id of ['phantom','solflare']){
  const entry=legacy.find(w=>w.id===id),b=$(id+'-connect');b.hidden=!entry;b.dataset.unavailable=String(!entry);
  $(id+'-hint').textContent='Detected ↗';b.onclick=()=>{if(entry)void connectWallet(async()=>{await entry.provider.connect();return entry.provider;});};
 }
 render();
}
$('wallet-rescan').onclick=refreshWallets;
addEventListener('focus',refreshWallets);
$('wallet-button').onclick=()=>{if(!game?.view().busy){walletNotice='';refreshWallets();$('wallet-dialog').showModal();}};
$('disconnect-button').onclick=async()=>{const previous=provider;rememberViewer(null);detach();try{await previous?.disconnect?.();}catch{}await game?.refresh();};
$('batch-stop').onclick=stopBatch;
$('play-button').onclick=()=>void play();
for(const event of ['pointerenter','focus'])$('play-button').addEventListener(event,warmSelectedPack);
$('outcome-dialog').addEventListener('close',warmSelectedPack);
for(const b of document.querySelectorAll('[data-pack]'))b.onclick=()=>{pack=Number(b.dataset.pack);render();warmSelectedPack();};
$('pack-withdraw').onclick=()=>void run('refund');for(const id of ['summary-claim','claim-rewards'])$(id).onclick=()=>void run('claim');
$('chain-refresh').onclick=async()=>{if(!game||game.view().busy)return;try{await game.refresh();message(net('Balances refreshed from devnet.','Balances refreshed from Solana mainnet.'));await resumePending();warmSelectedPack();}catch(e){message(e.message);}};
$('chain-receipt').onclick=async()=>{try{const r=await game.checkReceipt();message(r?.failed?'The transaction failed.':r?.expired?'The transaction expired without confirmation.':'Transaction confirmed. Balances refreshed.');resumePending();}catch(e){message(e.message);}render();};
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))dialog.close();});
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();$('outcome-action').onclick=()=>$('outcome-dialog').close();
const summaryTabs=[...document.querySelectorAll('[data-summary-tab]')];
for(const tab of summaryTabs){tab.onclick=()=>{for(const b of summaryTabs){const selected=b===tab;b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;$(b.getAttribute('aria-controls')).hidden=!selected;}};tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const index=e.key==='Home'?0:e.key==='End'?summaryTabs.length-1:(summaryTabs.indexOf(tab)+(e.key==='ArrowRight'?1:-1)+summaryTabs.length)%summaryTabs.length;summaryTabs[index].click();summaryTabs[index].focus();};}
function navigate(){const page=['play','fairness','rewards'].includes(location.hash.slice(1))?location.hash.slice(1):'play';for(const section of document.querySelectorAll('main > .page'))section.hidden=section.id!=='page-'+page;for(const link of document.querySelectorAll('[data-page]'))link.classList.toggle('active',link.dataset.page===page);}
addEventListener('hashchange',navigate);navigate();
$('motion-toggle').onclick=()=>{motion=!motion;world.setMotion(motion);$('motion-toggle').textContent=motion?'Motion on':'Motion off';};
document.addEventListener('visibilitychange',()=>{audio.setHidden(document.hidden);if(document.hidden){world.setMotion(false);game?.cancelWarmup?.();launchWatch?.stop();if(mainnet&&launchStatus){launchStatus={...launchStatus,automaticReveal:false,canPrepareSpin:false};render();}}else{world.setMotion(motion);launchWatch?.start();}});
const layout=initPlaygroundLayout(document);const unwatch=watchStandardWallets(refreshWallets);refreshWallets();render();
const launchWatch=mainnet?createMainnetLaunchWatch({onStatus:async state=>{
 launchStatus=state;
 if(!game&&state.gameReady)await initialize();
 else if(game&&!game.view().busy&&!running&&!animating&&!recovering){try{await game.refresh();await resumePending();}catch{}}
 if(!game){const waiting=launchPresentation(state);message(waiting.title,waiting.detail);}
 render();
}}):null;
addEventListener('pageshow',()=>{pageActive=true;if(!document.hidden)launchWatch?.start();});
addEventListener('pagehide',e=>{pageActive=false;launchWatch?.stop();game?.cancelWarmup?.();stopBatch();if(!e.persisted){layout.dispose();world.dispose();audio.dispose();unwatch();removeEventListener('focus',refreshWallets);unsubscribe();provider?.dispose?.();}});
async function initialize(){
 if(initializing||game||mainnet&&!launchStatus?.gameReady)return;initializing=true;
 try {
  const response=await fetch(configUrl,{cache:'no-store'});
  if(!response.ok)throw Error(net('Test game configuration is unavailable','Game configuration is unavailable'));
  game=makeGame({config:await response.json(),connection,storage:localStorage,sessionStorage:window.sessionStorage,onChange:render});
  // Wallet connection is independent of launch readiness. Keep an account that
  // connected while waiting instead of replacing it with a saved viewer.
  if(provider)game.setWallet(provider);
  await game.refresh();
  const restored=provider?false:await restoreViewer();
  if(!restored){
   message(net('The test game is ready.','SolSlot is ready.'),net('Connect your wallet on Devnet and press Spin. Approve a pack once. Its spins play automatically, with one results summary at the end.','Connect on Solana mainnet. Approve a pack once; results settle together and play back to back. Entries wait for creator fees to fund the pot.'));
   if(provider?.publicKey){rememberViewer(provider.publicKey.toBase58());await resumePending();warmSelectedPack();}
  }
  render();
 }
 catch(e){message(net('Unable to load the test game.','The game is not available yet.'),e.message);$('network-status').textContent=net('Connection unavailable · mainnet remains disabled','Mainnet entries paused · no transaction requested');if(!provider)game=null;}finally{initializing=false;}
}
if(mainnet){if(!document.hidden)launchWatch.start();}else void initialize();

}
