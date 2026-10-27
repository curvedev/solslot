import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=[['programs/game-core/src/lib.rs','game-core.rs.txt'],['programs/game-program/src/lib.rs','game-program.rs.txt'],['programs/game-program/src/orao.rs','orao.rs.txt'],['programs/game-program/src/tokens.rs','tokens.rs.txt']];
function excerpt(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0)throw Error('Randomness source boundary changed');return source.slice(a,b).trimEnd();}
export async function readRulesSource(manifest){
 const rows=await Promise.all(files.map(async([path,file])=>{const code=await readFile(path,'utf8');return {path,file,code,sha256:sha256(code)};}));
 const core=rows[0].code,program=rows[1].code,orao=rows[2].code;
 return {gameProgram:manifest.gameProgram,binarySha256:manifest.release.binarySha256,files:rows,excerpts:[
  {title:'1. Verify the fulfilled ORAO request',description:'Checks the oracle owner, account format, player and request address. All 64 bytes of the fulfilled result are hashed into the game’s randomness input.',file:'orao.rs.txt',code:excerpt(orao,'pub fn read_result(',"pub fn request<'a>")},
  {title:'2. Turn random bytes into a draw from 1–400',description:'The largest multiple of 400 below 2³² is 4,294,967,200. The remaining 96 values are skipped, avoiding modulo bias.',file:'game-core.rs.txt',code:excerpt(core,'pub fn draw_from_word(', '#[cfg(test)]')},
  {title:'3. Derive the draws for a spin pack',description:'One-spin entries read the authenticated bytes directly. Multi-spin packs use a separate hash for each spin; retry counters only reuse the same oracle result.',file:'game-program.rs.txt',code:excerpt(program,'fn batch_draws(', 'fn require(')},
  {title:'4. Apply the payout and burn rules',description:'Numbers 1–4 win the reserved SOL pot. Numbers 5–84 return tokens. The program records rewards, burns and any unused pack credits together.',file:'game-core.rs.txt',code:excerpt(core,'    pub fn settle_batch_verified(', '    /// Wrapper must prove oracle invalidation')},
 ]};
}
export async function writeRulesSource(review,directory){
 await mkdir(directory,{recursive:true});
 for(const row of review.files)await writeFile(`${directory}/${row.file}`,row.code);
 await writeFile(`${directory}/source-manifest.json`,JSON.stringify({gameProgram:review.gameProgram,binarySha256:review.binarySha256,buildFeature:'mainnet-orao',note:'Source snapshot and binary hash are not independent audit or reproducible-build proof.',files:review.files.map(({path,file,sha256})=>({source:path,file,sha256}))},null,2)+'\n');
}
