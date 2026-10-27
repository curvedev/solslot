// A private, bounded archive of proofs for already accepted requests.
// The caller MUST successfully simulate the exact authenticated reveal before
// saveVerified. This store does not verify oracle signatures or choose outcomes.
// Cached proofs must pass the normal on-chain validation again before sending.
import {createHash, randomBytes} from 'node:crypto';
import {constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {PublicKey} from '@solana/web3.js';

const RECORD_LIMIT_BYTES = 8192;
const addressFields = ['genesisHash', 'gameProgram', 'game', 'player', 'request', 'queue', 'oracle'];
const scalarFields = ['nonce', 'seedSlot'];
const contextFields = [...addressFields, ...scalarFields, 'seedSlothash', 'activeSignerHex', 'activeSignerExpiration'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { const error = Error('Oracle proof archive: ' + code); error.code = code; throw error; };
const need = (ok, code) => { if (!ok) fail(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function acceptedProofContext(value) {
  need(exactKeys(value, contextFields), 'invalid-context');
  const context = {};
  for (const name of addressFields) {
    try {
      need(typeof value[name] === 'string' && new PublicKey(value[name]).toBase58() === value[name], 'invalid-context');
      context[name] = value[name];
    } catch { fail('invalid-context'); }
  }
  for (const name of scalarFields) {
    need(typeof value[name] === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value[name]) && BigInt(value[name]) <= 18446744073709551615n, 'invalid-context');
    context[name] = value[name];
  }
  need(BigInt(context.seedSlot) > 0n, 'invalid-context');
  try {
    need(typeof value.seedSlothash === 'string' && new PublicKey(value.seedSlothash).toBase58() === value.seedSlothash, 'invalid-context');
  } catch { fail('invalid-context'); }
  need(typeof value.activeSignerHex === 'string' && /^[0-9a-f]{128}$/.test(value.activeSignerHex) && !/^0+$/.test(value.activeSignerHex), 'invalid-context');
  need(typeof value.activeSignerExpiration === 'string' && /^[1-9][0-9]{0,18}$/.test(value.activeSignerExpiration) && BigInt(value.activeSignerExpiration) <= 9223372036854775807n, 'invalid-context');
  context.seedSlothash = value.seedSlothash;
  context.activeSignerHex = value.activeSignerHex;
  context.activeSignerExpiration = value.activeSignerExpiration;
  return context;
}

function proofData(value) {
  need(exactKeys(value, ['signature', 'recovery_id', 'value']), 'invalid-proof');
  need(typeof value.signature === 'string', 'invalid-proof');
  const signature = Buffer.from(value.signature, 'base64');
  need(signature.length === 64 && signature.toString('base64') === value.signature, 'invalid-proof');
  need(Number.isInteger(value.recovery_id) && value.recovery_id >= 0 && value.recovery_id <= 3, 'invalid-proof');
  need(Array.isArray(value.value) && value.value.length === 32 && value.value.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'invalid-proof');
  return {signature: value.signature, recovery_id: value.recovery_id, value: [...value.value]};
}

function evidence(value, context) {
  need(exactKeys(value, ['transactionMessageSha256', 'simulationSlot']), 'invalid-verification');
  need(typeof value.transactionMessageSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.transactionMessageSha256), 'invalid-verification');
  need(Number.isSafeInteger(value.simulationSlot) && BigInt(value.simulationSlot) > BigInt(context.seedSlot), 'invalid-verification');
  return {...value};
}

function proofHash(proof) {
  return hash(Buffer.concat([Buffer.from(proof.signature, 'base64'), Buffer.from([proof.recovery_id]), Buffer.from(proof.value)]));
}

export function createOracleProofStore({directory, maxRecords = 100, now = Date.now} = {}) {
  // One serialized relayer process owns this directory and its transaction ledger.
  // Atomic no-overwrite publication also preserves first-proof immutability if a
  // restart overlaps accidentally, but capacity is not a cross-process lock.
  need(typeof directory === 'string' && directory.length > 0, 'private-directory-required');
  need(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 10000, 'invalid-capacity');
  const requested = resolve(directory);
  let root;
  try {
    mkdirSync(requested, {recursive: true, mode: 0o700});
    need(lstatSync(requested).isDirectory() && (lstatSync(requested).mode & 0o077) === 0, 'private-directory-required');
    root = realpathSync(requested);
  } catch { fail('private-directory-required'); }
  const key = context => hash(JSON.stringify(context));
  function get(value) {
    const context = acceptedProofContext(value), filename = join(root, key(context) + '.json');
    let fd;
    try {
      fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      need(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= RECORD_LIMIT_BYTES, 'corrupt-record');
      const record = JSON.parse(readFileSync(fd, 'utf8'));
      need(exactKeys(record, ['version', 'context', 'proof', 'proofSha256', 'verification', 'savedAt']) && record.version === 1, 'corrupt-record');
      need(JSON.stringify(acceptedProofContext(record.context)) === JSON.stringify(context), 'corrupt-record');
      const proof = proofData(record.proof);
      need(record.proofSha256 === proofHash(proof) && typeof record.savedAt === 'string' && Number.isFinite(Date.parse(record.savedAt)), 'corrupt-record');
      evidence(record.verification, context);
      return structuredClone(record);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('corrupt-record');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  function saveVerified(value, rawProof, rawVerification) {
    const context = acceptedProofContext(value), proof = proofData(rawProof), verification = evidence(rawVerification, context);
    const same = previous => {
      need(previous, 'corrupt-record');
      need(previous.proofSha256 === proofHash(proof), 'conflicting-proof');
      return previous;
    };
    const previous = get(context);
    if (previous) return same(previous);
    let count;
    try { count = readdirSync(root).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length; }
    catch { fail('storage-unavailable'); }
    need(count < maxRecords, 'capacity-reached');
    const record = {version: 1, context, proof, proofSha256: proofHash(proof), verification, savedAt: new Date(now()).toISOString()};
    const bytes = JSON.stringify(record) + '\n';
    need(Buffer.byteLength(bytes) <= RECORD_LIMIT_BYTES, 'record-too-large');
    const temporary = join(root, randomBytes(16).toString('hex') + '.tmp'), target = join(root, key(context) + '.json');
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      // link is an atomic no-overwrite publication; rename could replace a proof.
      try { linkSync(temporary, target); }
      catch (error) { if (error.code === 'EEXIST') return same(get(context)); throw error; }
      const directoryFd = openSync(root, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      return structuredClone(record);
    } catch (error) {
      if (['conflicting-proof', 'corrupt-record'].includes(error.code)) throw error;
      fail('storage-unavailable');
    } finally {
      try { if (fd !== undefined) closeSync(fd); } catch {}
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
    }
  }
  function assertCapacity() {
    need(readdirSync(root).filter(name => /^[0-9a-f]{64}\.json$/.test(name)).length < maxRecords, 'capacity-reached');
    // Admission also checks durable storage, before taking another entry.
    const path = join(root, randomBytes(16).toString('hex') + '.tmp');
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, 'probe'); fsyncSync(fd); } finally { closeSync(fd); unlinkSync(path); }
  }
  return {get, saveVerified, assertCapacity};
}
