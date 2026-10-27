import {readFile} from 'node:fs/promises';import {Connection} from '@solana/web3.js';import assert from 'node:assert/strict';
import {verifyLaunchProgramPins} from '../src/mainnet-launch-worker.js';import {createPrelaunchInspection} from '../src/prelaunch-readiness.js';
const endpoint=process.argv[2]??'https://solana-rpc.publicnode.com';assert.equal(new URL(endpoint).protocol,'https:');
const config=JSON.parse(await readFile(new URL('../config/mainnet.prepared.json',import.meta.url))),connection=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true});
assert.equal(await connection.getGenesisHash(),'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');await verifyLaunchProgramPins(connection,config.prelaunch.programPins);const state=await createPrelaunchInspection(connection,config)();
console.log(JSON.stringify({checkedAt:new Date().toISOString(),programPinsVerified:config.prelaunch.programPins.length,gameProgram:config.gameProgram,mint:config.mint,...state,transactionsSubmitted:0},null,2));
