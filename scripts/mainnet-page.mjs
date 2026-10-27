import {Window} from 'happy-dom';
import {playgroundPage} from './playground-page.mjs';
import {rulesPage} from './rules-page.mjs';
import {MAINNET_RPC_ENDPOINT} from '../src/mainnet-rpc.js';
export function mainnetPage(source,{orao=false,entryTokens='200000',consolationTokens='100000',sourceReview=null}={}){
 const w=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}}),d=w.document;d.write(playgroundPage(source));const $=id=>d.getElementById(id);
 d.title='SolSlot · Play on Solana';d.body.dataset.network='mainnet';
 d.querySelector('script[type="module"]').src='./mainnet-live.js';
 const csp=d.querySelector('[http-equiv="Content-Security-Policy"]'),rpc=new URL(MAINNET_RPC_ENDPOINT);csp.content=csp.content.replace('https://api.devnet.solana.com wss://api.devnet.solana.com',rpc.origin+' '+rpc.origin.replace('https:','wss:'));
 d.querySelector('meta[name="description"]').content='Spin with SLOT on Solana. Creator fees fund the SOL jackpot. 200,000 SLOT per spin; 1% jackpot, 20% half back.';
 d.querySelector('.demo-label').textContent='ON SOLANA';
 d.querySelector('.machine-display-heading').textContent='CURRENT JACKPOT · SOL';
 d.querySelector('.machine-jackpot-display').setAttribute('aria-label','Current SOL jackpot');
 $('machine-jackpot-usd').textContent='SOL';$('machine-quote-label').textContent='Solana mainnet';
 d.querySelector('.playground-rewards').setAttribute('aria-label','Your rewards and session');
 d.querySelector('.summary-demo').textContent='SOLANA MAINNET';
 d.querySelector('.session-console').setAttribute('aria-label','Your session');
 d.querySelector('#summary-session > .tiny-label').textContent='YOUR WALLET';
 d.querySelector('.session-console > div > .tiny-label').textContent='YOUR TOKEN BALANCE';
 $('result-title').textContent='Connecting to Solana…';$('result-detail').textContent='One approval per pack. Confirmed results play back to back.';
 $('price-status').textContent='The jackpot grows from creator fees we collect. Entries wait until the pot has SOL.';
 d.querySelector('.rewards-page .page-heading p').textContent='Claim your earned tokens and SOL. Unused prepaid credits can be returned from Play.';
 d.querySelector('#page-fairness .mode-label').textContent='ON-CHAIN RULES';
 if(orao){
  const note=d.createElement('p');note.className='spin-cost-note';note.textContent='One approval per pack · About 0.00185 SOL in randomness and network costs, for 1, 5 or 10 spins.';note.style.cssText='text-align:center;font-size:12px;margin:8px 12px;color:#344575';d.querySelector('.playground-controls').after(note);
 }
 d.querySelector('.fee-intro p').textContent='90% of creator fees we actually collect from this pump.fun coin and its canonical PumpSwap pool fund the jackpot; 10% goes to treasury. Pump sets the fee schedule, which can change. Unrelated pools do not fund this game.';
 d.querySelector('footer p').innerHTML='A little spin. A big moment.<br><small>Solana mainnet · Play responsibly</small>';
 d.querySelector('.outcome-demo').textContent='SLOT · SOLANA';
 d.querySelector('#wallet-dialog > p').textContent='Choose your Solana wallet on mainnet. Connecting shares your public address. Approve a pack once; its results settle and play automatically.';
 $('wallet-heading').textContent='Connect to SolSlot';// Keep recovery controls accessible in Rewards, without a banner over the game.
 const toolbar=d.querySelector('.chain-toolbar');toolbar.className='wallet-tools';toolbar.setAttribute('aria-label','Wallet tools');
 toolbar.querySelector('strong').remove();toolbar.querySelector('a').remove();$('network-status').hidden=true;
 $('chain-refresh').textContent='Refresh balances';$('page-rewards').append(toolbar);
 applyRulePrices(d,{entryTokens,consolationTokens});
 $('fairness-heading').textContent='Small spins. Clear rules.';
 d.querySelector('#page-fairness .page-heading p').textContent='The odds, the costs, and the code behind each result.';
 $('fairness-content').innerHTML=rulesPage({entryTokens,consolationTokens,orao,sourceReview});
 const style=d.createElement('link');style.rel='stylesheet';style.href='./rules.css';d.head.append(style);
 return '<!doctype html>\n'+d.documentElement.outerHTML;
}

function applyRulePrices(d,{entryTokens,consolationTokens}){
 const entry=Number(entryTokens),consolation=Number(consolationTokens);
 if(!((entry===200000&&consolation===100000)||(entry===50000&&consolation===50000)))throw Error('Unsupported game rules');
 d.body.dataset.entryTokens=String(entry);d.body.dataset.consolationTokens=String(consolation);
 if(entry===50000){
  for(const node of d.querySelectorAll('[aria-label]'))node.setAttribute('aria-label',node.getAttribute('aria-label').replaceAll('100,000','50,000').replaceAll('200,000','50,000'));
  const walk=d.createTreeWalker(d.body,4);let node;while(node=walk.nextNode())node.textContent=node.textContent.replaceAll('200,000','50,000').replaceAll('100,000','50,000').replaceAll('Half your entry','Your full entry').replaceAll('half your entry','your full entry').replaceAll('Half-back results burn 50,000 tokens','Matching results return the full entry without burning tokens').replaceAll('The other 50,000 tokens burn.','No entry tokens burn on a match.').replaceAll('Consolation spins burn the other half; losing spins burn the full entry.','Consolation matches return the full entry with no token burn; jackpot and no-match spins burn the full entry.').replaceAll('half back','entry back').replaceAll('Half back','Entry back');
  d.querySelector('meta[name="description"]').content='Spin with SLOT on Solana. Creator fees fund the SOL jackpot. 50,000 SLOT per spin; 1% jackpot, 20% full entry back.';
 }
}
export function pricedDemoHtml(source,rules){
 const w=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}}),d=w.document;d.write(source);applyRulePrices(d,rules);d.querySelector('meta[name="description"]').content='SolSlot demo. Simulated tokens and prizes only; no real funds.';return '<!doctype html>\n'+d.documentElement.outerHTML;
}
