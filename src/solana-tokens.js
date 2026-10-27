import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MINT_SIZE, ACCOUNT_SIZE, ExtensionType, getExtensionTypes, unpackMint, unpackAccount } from '@solana/spl-token';

const need = (ok, message) => { if (!ok) throw Error(message); };

// Missing configuration preserves the existing legacy-token devnet game.
// Every read checks the chosen program against the actual account owner.
export function gameTokenProgram(config) {
  const value = config.tokenProgram;
  if (value === undefined || value === 'spl-token' || value === TOKEN_PROGRAM_ID.toBase58()) return TOKEN_PROGRAM_ID;
  if (value === 'token-2022' || value === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  throw Error('Unsupported game token program');
}

function checkExtensions(info, decoded, program, legacySize, allowed) {
  if (program.equals(TOKEN_PROGRAM_ID)) need(info.data.length === legacySize, 'Unexpected legacy token account layout');
  else need(getExtensionTypes(decoded.tlvData).every(type => allowed.includes(type)), 'Unsupported game token extension');
}

export function verifyGameMint(address, info, program) {
  need(info?.owner?.equals(program), 'Game mint token program does not match configuration');
  const mint = unpackMint(new PublicKey(address), info, program);
  need(mint.isInitialized && mint.decimals === 6 && mint.mintAuthority === null && mint.freezeAuthority === null, 'Game mint must have six decimals and revoked mint/freeze authorities');
  checkExtensions(info, mint, program, MINT_SIZE, [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
  return mint;
}

export function verifyGameTokenAccount(address, info, mint, owner, program) {
  need(info?.owner?.equals(program), 'Token account program does not match the game mint');
  const token = unpackAccount(new PublicKey(address), info, program);
  need(token.mint.equals(mint) && token.owner.equals(owner), 'Token account identity mismatch');
  need(token.isInitialized && !token.isFrozen && token.delegate === null && token.closeAuthority === null, 'Game token account must be initialized, unfrozen and without delegate or close authority');
  checkExtensions(info, token, program, ACCOUNT_SIZE, [ExtensionType.ImmutableOwner]);
  return token;
}
