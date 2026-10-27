import http from 'node:http';
import {createHandler,serverSettings} from '../src/http-server.js';
import {loadDevnetSettler} from '../src/devnet-settler.js';
import {createSettlementRecovery} from '../src/settlement-recovery.js';
const {port,host,origins,redirectOrigins}=serverSettings(process.env);
const settler=loadDevnetSettler();
const recovery=settler?createSettlementRecovery({recover:()=>settler.recoverPending()}):null;
const server=http.createServer(createHandler({origins,redirectOrigins,settler}));
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(port,host,()=>{
 recovery?.start();
 console.log(`Solpot devnet server ready on port ${port}. Mainnet disabled.`);
});
let closing=false;
async function shutdown(){
 if(closing)return;closing=true;
 const closed=new Promise(resolve=>server.close(resolve));
 await recovery?.stop();
 await closed;
 await settler?.drain();
 process.exit(0);
}
process.on('SIGTERM',shutdown);
process.on('SIGINT',shutdown);
