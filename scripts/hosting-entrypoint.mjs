// Optional Railway volume initialization. The HTTP process always runs as node.
import { access, chmod, chown, lstat, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { publicDevnetConfig } from '../src/solana-game.js';

const RUNTIME = '/var/lib/solpot/runtime';
const NODE_UID = 1000, NODE_GID = 1000;
const need = (ok, message) => { if (!ok) throw Error(message); };
export function hostingPaths(env) {
  if (!env.SOLPOT_DEVNET_RELAYER_KEYPAIR && !env.SOLPOT_DEVNET_RELAYER_STATE) return null;
  need(env.SOLPOT_DEVNET_RELAYER_KEYPAIR && env.SOLPOT_DEVNET_RELAYER_STATE, 'Both private devnet runtime paths are required.');
  const key = resolve(env.SOLPOT_DEVNET_RELAYER_KEYPAIR), ledger = resolve(env.SOLPOT_DEVNET_RELAYER_STATE);
  need(key === `${RUNTIME}/devnet-relayer-keypair.json`, 'Use the dedicated devnet runtime key path.');
  need(ledger === `${RUNTIME}/devnet-relayer-state.json`, 'Use the dedicated durable ledger path.');
  need(env.RAILWAY_VOLUME_MOUNT_PATH === '/var/lib/solpot', 'Attach the durable Railway volume before enabling automatic devnet spins.');
  return { key, ledger, runtime: RUNTIME };
}
async function regularFile(path, { optional = false } = {}) {
  let stat; try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return false; throw error; }
  need(stat.isFile() && !stat.isSymbolicLink(), 'Runtime files must be regular files, not links.'); return true;
}
function signerJson(text) {
  const value = JSON.parse(text);
  need(Array.isArray(value) && value.length === 64 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'Invalid dedicated devnet signer.');
  return { bytes: value, address: Keypair.fromSecretKey(Uint8Array.from(value)).publicKey.toBase58() };
}
function checkLedger(value, config, payer) {
  need(value && typeof value === 'object' && !Array.isArray(value) && value.gameProgram === config.gameProgram && value.mint === config.mint && value.payer === payer && Array.isArray(value.attempts) && value.attempts.length <= 100, 'Runtime ledger identity/content mismatch.');
  need(value.attempts.every(row => row && typeof row === 'object' && typeof row.id === 'string' && row.id.length < 2048 && ['prepared', 'submitted', 'confirmed', 'failed', 'expired'].includes(row.status) && Number.isSafeInteger(row.reservedLamports) && row.reservedLamports >= 0), 'Invalid runtime attempt ledger.');
  return value;
}
export async function bootstrapPrivateFiles(paths, env, config) {
  const keyText = env.SOLPOT_DEVNET_RELAYER_KEYPAIR_JSON, ledgerText = env.SOLPOT_DEVNET_RELAYER_LEDGER_JSON;
  // Never pass bootstrap secrets into server modules or subprocesses.
  delete env.SOLPOT_DEVNET_RELAYER_KEYPAIR_JSON; delete env.SOLPOT_DEVNET_RELAYER_LEDGER_JSON;
  if (keyText === undefined && ledgerText === undefined) return;
  need(paths && typeof keyText === 'string' && typeof ledgerText === 'string', 'Both private bootstrap values and mounted runtime paths are required.');
  need(keyText.length < 4096 && ledgerText.length < 1_000_000, 'Bootstrap input is too large.');
  config = publicDevnetConfig(config);
  const signer = signerJson(keyText), ledger = checkLedger(JSON.parse(ledgerText), config, signer.address);
  need(![config.owner, config.treasury].includes(signer.address), 'Use the dedicated devnet relayer, never the administrator.');
  const keyExists = await regularFile(paths.key, { optional: true }), ledgerExists = await regularFile(paths.ledger, { optional: true });
  if (keyExists) {
    const stored = signerJson(await readFile(paths.key, 'utf8'));
    need(JSON.stringify(stored.bytes) === JSON.stringify(signer.bytes), 'Existing signer differs; never overwrite it.');
  }
  if (ledgerExists) checkLedger(JSON.parse(await readFile(paths.ledger, 'utf8')), config, signer.address);
  // Existing ledger is authoritative and may have advanced since bootstrap.
  // Never replace it with the old environment snapshot on a restart.
  if (!keyExists) await writeFile(paths.key, JSON.stringify(signer.bytes), { flag: 'wx', mode: 0o600 });
  if (!ledgerExists) await writeFile(paths.ledger, JSON.stringify(ledger), { flag: 'wx', mode: 0o600 });
}
export async function startHostedServer(env = process.env) {
  const paths = hostingPaths(env);
  if (paths) {
    const mount = await lstat(dirname(paths.runtime));
    need(mount.isDirectory() && !mount.isSymbolicLink(), 'Expected the mounted runtime directory.');
    await mkdir(paths.runtime, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const runtime = await lstat(paths.runtime);
    need(runtime.isDirectory() && !runtime.isSymbolicLink(), 'Runtime directory must not be a link.');
    await bootstrapPrivateFiles(paths, env, JSON.parse(await readFile('dist/devnet-config.json', 'utf8')));
    if (process.getuid() === 0) {
      // Touch only this service's dedicated directory and explicitly named files.
      await chown(paths.runtime, NODE_UID, NODE_GID); await chmod(paths.runtime, 0o700);
      for (const [path, optional] of [[paths.key, false], [paths.ledger, true], [`${paths.ledger}.tmp`, true]]) {
        if (await regularFile(path, { optional })) { await chown(path, NODE_UID, NODE_GID); await chmod(path, 0o600); }
      }
      const proofDirectory = `${paths.ledger}.proofs`;
      let proofStat; try { proofStat = await lstat(proofDirectory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (proofStat) {
        need(proofStat.isDirectory() && !proofStat.isSymbolicLink(), 'Invalid private proof directory.');
        await chown(proofDirectory, NODE_UID, NODE_GID); await chmod(proofDirectory, 0o700);
        const names = await readdir(proofDirectory);
        need(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length <= 100, 'Proof archive is too large.');
        for (const name of names) {
          if (/^[a-f0-9]{32}\.tmp$/.test(name)) continue;
          need(/^[a-f0-9]{64}\.json$/.test(name), 'Unexpected proof archive file.');
          const path = `${proofDirectory}/${name}`; await regularFile(path);
          need((await lstat(path)).size <= 8192, 'Unexpected proof record size.');
          await chown(path, NODE_UID, NODE_GID); await chmod(path, 0o600);
        }
      }
    }
  } else {
    need(!env.SOLPOT_DEVNET_RELAYER_KEYPAIR_JSON && !env.SOLPOT_DEVNET_RELAYER_LEDGER_JSON, 'Bootstrap values require the durable relayer configuration.');
  }
  if (process.getuid() === 0) {
    process.setgroups([]); process.setgid(NODE_GID); process.setuid(NODE_UID);
  }
  need(process.getuid() === NODE_UID, 'Hosted HTTP service must run as the node user.');
  if (paths) {
    await regularFile(paths.key); await access(paths.key, constants.R_OK);
    await access(paths.runtime, constants.R_OK | constants.W_OK | constants.X_OK);
    if (await regularFile(paths.ledger, { optional: true })) await access(paths.ledger, constants.R_OK | constants.W_OK);
  }
  await import('./serve.mjs');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startHostedServer().catch(() => { console.error('Hosted startup failed. Check the public origin, mounted volume, private runtime paths and file ownership. No signer contents are logged.'); process.exitCode = 1; });
}
