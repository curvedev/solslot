//! Minimal pinned ORAO RequestV2 ABI. The upstream program verifies the quorum.
//! Accept only a newly created request; a known result must never buy an entry.
use super::*;
use solana_program::instruction::{Instruction,AccountMeta};
pub const ID:Pubkey=solana_program::pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
pub const NETWORK:Pubkey=solana_program::pubkey!("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");
const REQUEST_DISC:[u8;8]=[38,151,209,6,195,102,28,217];
const RESULT_DISC:[u8;8]=[139,239,184,215,227,86,191,226];
const NETWORK_DISC:[u8;8]=[212,237,148,56,97,245,51,169];
pub fn request_address(seed:&[u8;32])->Pubkey{Pubkey::find_program_address(&[b"orao-vrf-randomness-request",seed],&ID).0}
pub fn network(account:&AccountInfo,treasury:Option<&Pubkey>)->ProgramResult{
 require(account.key==&NETWORK && account.owner==&ID)?;
 let d=account.try_borrow_data()?;require(d.len()>=85 && d[..8]==NETWORK_DISC)?;
 let fee=u64::from_le_bytes(d[72..80].try_into().unwrap());
 let count=u32::from_le_bytes(d[80..84].try_into().unwrap()) as usize;
 require(fee<=500_000 && (3..=10).contains(&count) && d.len()>=85+count*32)?;
 if let Some(key)=treasury{require(d[40..72]==key.to_bytes())?;}
 Ok(())
}
pub fn read_result(account:&AccountInfo,client:&Pubkey,fulfilled:bool)->Result<([u8;32],Option<[u8;32]>),ProgramError>{
 require(account.owner==&ID)?;let d=account.try_borrow_data()?;
 require(d.len()>=73 && d[..8]==RESULT_DISC && d[8]<=1 && d[9..41]==client.to_bytes())?;
 let seed:[u8;32]=d[41..73].try_into().unwrap();require(account.key==&request_address(&seed))?;
 if fulfilled {
  require(d[8]==1 && d.len()==137)?;
  // Hash all 64 quorum bytes into the game's fixed 32-byte randomness input.
  Ok((seed,Some(solana_program::hash::hashv(&[b"solpot:orao:v1",&d[73..137]]).to_bytes())))
 }else{
  require(d[8]==0 && d.len()>=77)?;
  let count=u32::from_le_bytes(d[73..77].try_into().unwrap()) as usize;
  require(count==0 && d.len()==749)?;Ok((seed,None))
 }
}
pub fn request<'a>(actor:&AccountInfo<'a>,state:&AccountInfo<'a>,treasury:&AccountInfo<'a>,random:&AccountInfo<'a>,sys:&AccountInfo<'a>,program:&AccountInfo<'a>,seed:[u8;32])->ProgramResult{
 require(program.key==&ID && program.executable && sys.key==&system_program::id())?;
 require(random.key==&request_address(&seed) && random.owner==&system_program::id() && random.data_is_empty())?;
 network(state,Some(treasury.key))?;
 let mut data=REQUEST_DISC.to_vec();data.extend_from_slice(&seed);
 let ix=Instruction{program_id:ID,accounts:vec![AccountMeta::new(*actor.key,true),AccountMeta::new(NETWORK,false),AccountMeta::new(*treasury.key,false),AccountMeta::new(*random.key,false),AccountMeta::new_readonly(system_program::id(),false)],data};
 invoke(&ix,&[actor.clone(),state.clone(),treasury.clone(),random.clone(),sys.clone(),program.clone()])?;
 require(read_result(random,actor.key,false)?.0==seed)
}
