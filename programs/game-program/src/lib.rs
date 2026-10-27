//! Development Solana program. The web build deliberately does not send transactions.
#![allow(unexpected_cfgs, deprecated)]
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::{next_account_info, AccountInfo}, entrypoint::ProgramResult, program::{invoke,invoke_signed}, program_error::ProgramError, pubkey::Pubkey, system_instruction, system_program, bpf_loader_upgradeable, sysvar::{Sysvar, clock::Clock, rent::Rent, slot_hashes}};
use solana_pot_game_core::{Game,Player,draw_from_word};
mod tokens;
mod orao;
use spl_token_2022::state::Mint;
use switchboard_on_demand::{accounts::RandomnessAccountData, instructions::RandomnessCommit};

#[cfg(not(feature="no-entrypoint"))]
solana_program::entrypoint!(process_instruction);
const GAME_LEN:usize=512;
const PLAYER_LEN:usize=256;
const GAME_MAGIC:[u8;8]=*b"SOLPOT03";
// Same layout, but entries stay unavailable until the reserved mint is verified.
const PRELAUNCH_MAGIC:[u8;8]=*b"SOLPRE01";
const PLAYER_MAGIC:[u8;8]=*b"PLAYER02";
#[derive(BorshSerialize,BorshDeserialize,Clone)]
struct GameAccount { magic:[u8;8],owner:Pubkey,treasury:Pubkey,mint:Pubkey,oracle_program:Pubkey,queue:Pubkey,bump:u8,decimals:u8,seed_slot:u64,open_players:u64,open_oracles:u64,core:Game }
#[derive(BorshSerialize,BorshDeserialize,Clone)]
struct PlayerAccount { magic:[u8;8],game:Pubkey,player:Player,session:Pubkey,session_expiry:u64,session_spins:u64,bump:u8,receipt:BatchReceipt }
// Appended to PLAYER02 padding: durable results survive refresh and oracle reuse.
#[derive(BorshSerialize,BorshDeserialize,Clone,Default)]
struct BatchReceipt { nonce:u64,seed_slot:u64,locked_pot:u64,requested:u8,played:u8,draws:[u16;10],request:[u8;32] }
fn batch_draws(bytes:&[u8;32],game:&Pubkey,nonce:u64,seed_slot:u64,count:u8)->Result<[u16;10],ProgramError>{
 require((1..=10).contains(&count))?;
 let mut draws=[0u16;10];
 for index in 0..count {
  if count==1 { draws[0]=bytes.chunks_exact(4).find_map(|b|draw_from_word(u32::from_le_bytes(b.try_into().unwrap()))).ok_or(ProgramError::InvalidAccountData)?; break; }
  let mut draw=None;
  for counter in 0..16u8 {
   let digest=solana_program::hash::hashv(&[b"solpot:batch:v1",bytes,game.as_ref(),&nonce.to_le_bytes(),&seed_slot.to_le_bytes(),&[index,counter]]).to_bytes();
   draw=digest.chunks_exact(4).find_map(|b|draw_from_word(u32::from_le_bytes(b.try_into().unwrap())));
   if draw.is_some(){break;}
  }
  draws[usize::from(index)]=draw.ok_or(ProgramError::InvalidAccountData)?;
 }
 Ok(draws)
}
fn require(ok:bool)->ProgramResult { if ok {Ok(())} else {Err(ProgramError::InvalidArgument)} }
fn core<T>(r:Result<T,solana_pot_game_core::Error>)->Result<T,ProgramError>{r.map_err(|_|ProgramError::Custom(100))}
fn read<T:BorshDeserialize>(a:&AccountInfo)->Result<T,ProgramError>{T::deserialize(&mut &a.try_borrow_data()?[..]).map_err(|_|ProgramError::InvalidAccountData)}
fn save<T:BorshSerialize>(a:&AccountInfo,s:&T)->ProgramResult {let bytes=borsh::to_vec(s).map_err(|_|ProgramError::InvalidAccountData)?;let mut data=a.try_borrow_mut_data()?;require(bytes.len()<=data.len())?;data.fill(0);data[..bytes.len()].copy_from_slice(&bytes);Ok(())}
fn signer(a:&AccountInfo,key:&Pubkey)->ProgramResult{if !a.is_signer{return Err(ProgramError::MissingRequiredSignature)}require(a.key==key)}
fn load_game(pid:&Pubkey,a:&AccountInfo)->Result<GameAccount,ProgramError>{require(a.owner==pid && a.is_writable && a.data_len()==GAME_LEN)?;let g:GameAccount=read(a)?;require(g.magic==GAME_MAGIC || g.magic==PRELAUNCH_MAGIC)?;let key=Pubkey::create_program_address(&[b"game",g.mint.as_ref(),&[g.bump]],pid)?;require(a.key==&key)?;Ok(g)}
fn load_player(pid:&Pubkey,a:&AccountInfo,game:&Pubkey)->Result<PlayerAccount,ProgramError>{require(a.owner==pid && a.is_writable && a.data_len()==PLAYER_LEN)?;let p:PlayerAccount=read(a)?;require(p.magic==PLAYER_MAGIC && p.game==*game)?;let key=Pubkey::create_program_address(&[b"player",game.as_ref(),&p.player.key,&[p.bump]],pid)?;require(a.key==&key)?;Ok(p)}
fn u64arg(data:&[u8])->Result<u64,ProgramError>{require(data.len()==8)?;Ok(u64::from_le_bytes(data.try_into().unwrap()))}
fn move_sol(from:&AccountInfo,to:&AccountInfo,amount:u64)->ProgramResult {require(from.key!=to.key)?;let f=from.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;let t=to.lamports().checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;**from.try_borrow_mut_lamports()?=f;**to.try_borrow_mut_lamports()?=t;Ok(())}
fn mint_account(a:&AccountInfo,g:&GameAccount)->Result<Mint,ProgramError>{require(a.key==&g.mint)?;let m=tokens::mint(a)?;require(m.decimals==g.decimals)?;Ok(m)}
fn sol_coverage(a:&AccountInfo,g:&GameAccount)->ProgramResult {let min=Rent::get()?.minimum_balance(a.data_len());let needed=min.checked_add(core(g.core.accounted_sol())?).ok_or(ProgramError::ArithmeticOverflow)?;require(a.lamports()>=needed)}
fn token_coverage(a:&AccountInfo,g:&GameAccount,game:&Pubkey,program:&Pubkey)->ProgramResult{let ata_program=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");let (expected,_)=Pubkey::find_program_address(&[game.as_ref(),program.as_ref(),g.mint.as_ref()],&ata_program);require(a.key==&expected)?;let t=tokens::account(a,&g.mint,game,program)?;require(t.amount>=core(g.core.protected_tokens())?)}
fn create_pda<'a>(payer:&AccountInfo<'a>,account:&AccountInfo<'a>,sys:&AccountInfo<'a>,pid:&Pubkey,len:usize,seeds:&[&[u8]])->ProgramResult{
 require(sys.key==&system_program::id() && account.owner==&system_program::id() && account.data_is_empty())?;
 let rent=Rent::get()?.minimum_balance(len);
 if account.lamports()==0{return invoke_signed(&system_instruction::create_account(payer.key,account.key,rent,len as u64,pid),&[payer.clone(),account.clone(),sys.clone()],&[seeds])}
 // Anyone can send SOL to a known PDA before initialization. Preserve that
 // balance and allocate/assign with PDA authority instead of failing creation.
 let top_up=rent.saturating_sub(account.lamports());
 if top_up>0{invoke(&system_instruction::transfer(payer.key,account.key,top_up),&[payer.clone(),account.clone(),sys.clone()])?;}
 invoke_signed(&system_instruction::allocate(account.key,len as u64),&[account.clone(),sys.clone()],&[seeds])?;
 invoke_signed(&system_instruction::assign(account.key,pid),&[account.clone(),sys.clone()],&[seeds])
}

/// Tags and ordered account layouts are documented in docs/PROGRAM.md.
pub fn process_instruction(pid:&Pubkey,accounts:&[AccountInfo],data:&[u8])->ProgramResult{
 let (&tag,args)=data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
 let iter=&mut accounts.iter();
 match tag {
  0|19=>{ // initialize / reserve a future mint: dev, game, mint, treasury, oracle program, queue, system
   require(args.is_empty())?;let dev=next_account_info(iter)?;let game=next_account_info(iter)?;let mint=next_account_info(iter)?;let treasury=next_account_info(iter)?;let oracle=next_account_info(iter)?;let queue=next_account_info(iter)?;let sys=next_account_info(iter)?;
   let program_data=next_account_info(iter)?;signer(dev,dev.key)?;
   let (expected_program_data,_)=Pubkey::find_program_address(&[pid.as_ref()],&bpf_loader_upgradeable::id());
   require(program_data.key==&expected_program_data && program_data.owner==&bpf_loader_upgradeable::id())?;
   {let d=program_data.try_borrow_data()?;require(d.len()>=45 && d[..4]==3u32.to_le_bytes() && d[12]==1 && d[13..45]==dev.key.to_bytes())?;}
   require(dev.key!=treasury.key && treasury.key!=&Pubkey::default())?;
   require(oracle.executable && [switchboard_on_demand::get_sb_program_id("mainnet"),switchboard_on_demand::get_sb_program_id("devnet"),orao::ID].contains(oracle.key) && queue.owner==oracle.key)?;
   if oracle.key==&orao::ID{orao::network(queue,None)?;}
   let (magic,decimals)=if tag==19 {
    require(mint.key!=&Pubkey::default() && mint.key!=dev.key && mint.key!=treasury.key && mint.owner==&system_program::id() && mint.data_is_empty())?;
    (PRELAUNCH_MAGIC,6)
   }else{let m=tokens::mint(mint)?;(GAME_MAGIC,m.decimals)};
   let (key,bump)=Pubkey::find_program_address(&[b"game",mint.key.as_ref()],pid);require(game.key==&key)?;
   create_pda(dev,game,sys,pid,GAME_LEN,&[b"game",mint.key.as_ref(),&[bump]])?;
   save(game,&GameAccount{magic,owner:*dev.key,treasury:*treasury.key,mint:*mint.key,oracle_program:*oracle.key,queue:*queue.key,bump,decimals,seed_slot:0,open_players:0,open_oracles:0,core:core(Game::new(decimals as u32))?})
  },
  20=>{ // Anyone may activate only the exact reserved, valid mint. No roles change.
   require(args.is_empty())?;let game=next_account_info(iter)?;let mint=next_account_info(iter)?;let mut g=load_game(pid,game)?;
   require(g.magic==PRELAUNCH_MAGIC && !g.core.closed() && g.open_players==0 && (g.open_oracles>0 || g.oracle_program==orao::ID) && g.core.pending().is_none())?;
   mint_account(mint,&g)?;core(g.core.configure_prelaunch_rules(g.decimals as u32))?;g.magic=GAME_MAGIC;sol_coverage(game,&g)?;save(game,&g)
  },
  21=>{ // Recover an abandoned reservation without needing a mint or token vault.
   require(args.is_empty())?;let dev=next_account_info(iter)?;let game=next_account_info(iter)?;let g=load_game(pid,game)?;signer(dev,&g.owner)?;
   require(g.magic==PRELAUNCH_MAGIC && g.core.closed() && g.open_players==0 && g.open_oracles==0 && g.core.pending().is_none() && core(g.core.protected_sol())?==0 && core(g.core.protected_tokens())?==0)?;
   move_sol(game,dev,game.lamports())?;game.realloc(0,false)?;game.assign(&system_program::id());Ok(())
  },
  1=>{ // open player: owner, game, player, system
   require(args.is_empty())?;let owner=next_account_info(iter)?;let game=next_account_info(iter)?;let account=next_account_info(iter)?;let sys=next_account_info(iter)?;signer(owner,owner.key)?;let mut g=load_game(pid,game)?;require(g.magic==GAME_MAGIC && !g.core.closed())?;
   let (key,bump)=Pubkey::find_program_address(&[b"player",game.key.as_ref(),owner.key.as_ref()],pid);require(account.key==&key)?;
   create_pda(owner,account,sys,pid,PLAYER_LEN,&[b"player",game.key.as_ref(),owner.key.as_ref(),&[bump]])?;
   g.open_players=g.open_players.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;save(game,&g)?;
   save(account,&PlayerAccount{magic:PLAYER_MAGIC,game:*game.key,player:Player::new(owner.key.to_bytes()),session:Pubkey::default(),session_expiry:0,session_spins:0,bump,receipt:BatchReceipt::default()})
  },
  22=>{ // DEV migrates only a never-activated, empty reservation to ORAO.
   require(args.is_empty())?;let dev=next_account_info(iter)?;let game=next_account_info(iter)?;let oracle=next_account_info(iter)?;let network=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;signer(dev,&g.owner)?;
   require(g.magic==PRELAUNCH_MAGIC && !g.core.closed() && g.open_players==0 && g.open_oracles==0 && g.core.pending().is_none() && core(g.core.protected_tokens())?==0 && core(g.core.accounted_sol())?==0)?;
   require(oracle.key==&orao::ID && oracle.executable)?;orao::network(network,None)?;
   // Switchboard closes to its authority (this game PDA), so return that
   // unaccounted deposit to DEV while this reservation has no obligations.
   let excess=game.lamports().checked_sub(Rent::get()?.minimum_balance(game.data_len())).ok_or(ProgramError::InsufficientFunds)?;
   if excess>0{move_sol(game,dev,excess)?;}
   g.oracle_program=orao::ID;g.queue=orao::NETWORK;g.seed_slot=0;sol_coverage(game,&g)?;save(game,&g)
  },
  23=>{ // Atomic ORAO request + entry: wallet, game, player, request, network, treasury, system, oracle.
   require(args.len()==33 && [1,5,10].contains(&args[0]))?;let count=args[0];let seed:[u8;32]=args[1..].try_into().unwrap();
   let actor=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let random=next_account_info(iter)?;let network=next_account_info(iter)?;let treasury=next_account_info(iter)?;let sys=next_account_info(iter)?;let oracle=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;let mut p=load_player(pid,pa,game.key)?;signer(actor,&Pubkey::new_from_array(p.player.key))?;
   require(g.magic==GAME_MAGIC && g.oracle_program==orao::ID && g.queue==orao::NETWORK)?;
   // Both operations roll back together. Pre-created/pending/fulfilled requests
   // are rejected by the exact CPI before they can be admitted into this game.
   core(g.core.begin_batch(&mut p.player,random.key.to_bytes(),count))?;
   orao::request(actor,network,treasury,random,sys,oracle,seed)?;
   g.seed_slot=Clock::get()?.slot;sol_coverage(game,&g)?;save(game,&g)?;save(pa,&p)
  },
  2=>{ // buy pack: owner, game, player, source token, vault token, mint, token program
   let count=u64arg(args)?;let owner=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let source=next_account_info(iter)?;let vault=next_account_info(iter)?;let mint=next_account_info(iter)?;let tp=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;require(g.magic==GAME_MAGIC)?;let mut p=load_player(pid,pa,game.key)?;signer(owner,&Pubkey::new_from_array(p.player.key))?;require(tp.key==mint.owner && tokens::supported_program(tp.key))?;mint_account(mint,&g)?;tokens::account(source,&g.mint,owner.key,tp.key)?;token_coverage(vault,&g,game.key,tp.key)?;
   let amount=core(g.core.buy_pack(&mut p.player,count))?;
   invoke(&spl_token_2022::instruction::transfer_checked(tp.key,source.key,mint.key,vault.key,owner.key,&[],amount,g.decimals)?,&[source.clone(),mint.clone(),vault.clone(),owner.clone(),tp.clone()])?;
   token_coverage(vault,&g,game.key,tp.key)?;save(game,&g)?;save(pa,&p)
  },
  #[cfg(not(feature="mainnet-orao"))]
  3|17=>{ // begin + oracle commit atomically: player/session, game, player PDA, randomness, queue, oracle node, slothashes, oracle program
   let count=if tag==3 {require(args.is_empty())?;1} else {require(args.len()==1 && (1..=10).contains(&args[0]))?;args[0]};let actor=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let random=next_account_info(iter)?;let queue=next_account_info(iter)?;let node=next_account_info(iter)?;let hashes=next_account_info(iter)?;let oracle=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;require(g.magic==GAME_MAGIC)?;let mut p=load_player(pid,pa,game.key)?;let clock=Clock::get()?;
   if actor.key==&Pubkey::new_from_array(p.player.key){signer(actor,actor.key)?}else{signer(actor,&p.session)?;require(clock.slot<=p.session_expiry && p.session_spins>=u64::from(count))?;p.session_spins-=u64::from(count);}
   require(oracle.key==&g.oracle_program && oracle.executable && random.owner==oracle.key && queue.key==&g.queue && queue.owner==oracle.key && node.owner==oracle.key && hashes.key==&slot_hashes::id())?;
   {let r=RandomnessAccountData::parse(random.try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;require(r.authority==*game.key && r.queue==g.queue)?;}
   // Consume and reserve before CPI. Solana rolls back all state/CPI if any check fails.
   core(g.core.begin_batch(&mut p.player,random.key.to_bytes(),count))?;
   RandomnessCommit::invoke(oracle.clone(),random.clone(),queue.clone(),node.clone(),game.clone(),hashes.clone(),&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   {let r=RandomnessAccountData::parse(random.try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;require(r.seed_slot>g.seed_slot && r.seed_slot==clock.slot.checked_sub(1).ok_or(ProgramError::InvalidArgument)? && r.reveal_slot<r.seed_slot)?;g.seed_slot=r.seed_slot;}
   sol_coverage(game,&g)?;save(game,&g)?;save(pa,&p)
  },
  4=>{ // permissionless settle: game, player, randomness, token vault, mint, token program
   require(args.is_empty())?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let random=next_account_info(iter)?;let vault=next_account_info(iter)?;let mint=next_account_info(iter)?;let tp=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;let mut p=load_player(pid,pa,game.key)?;let pending=g.core.pending().ok_or(ProgramError::InvalidArgument)?;
   require(random.key.to_bytes()==pending.oracle_request && random.owner==&g.oracle_program && tp.key==mint.owner && tokens::supported_program(tp.key))?;mint_account(mint,&g)?;token_coverage(vault,&g,game.key,tp.key)?;
   // A verified reveal stays usable for this exact committed seed. Requiring the
   // current slot would strand a spin when reveal lands before its settlement.
   let bytes=if g.oracle_program==orao::ID {
    require(g.queue==orao::NETWORK)?;orao::read_result(random,&Pubkey::new_from_array(p.player.key),true)?.1.ok_or(ProgramError::InvalidAccountData)?
   }else{let r=RandomnessAccountData::parse(random.try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;require(r.authority==*game.key && r.queue==g.queue && r.seed_slot==g.seed_slot && r.reveal_slot>g.seed_slot && r.reveal_slot<=Clock::get()?.slot)?;r.value};
   let count=g.core.pending_count();
   let draws=batch_draws(&bytes,game.key,pending.nonce,g.seed_slot,count)?;
   let (settled,played)=core(g.core.settle_batch_verified(&mut p.player,pending.nonce,random.key.to_bytes(),&draws[..usize::from(count)]))?;
   p.receipt=BatchReceipt{nonce:pending.nonce,seed_slot:g.seed_slot,locked_pot:pending.locked_pot,requested:count,played,draws,request:random.key.to_bytes()};
   invoke_signed(&spl_token_2022::instruction::burn_checked(tp.key,vault.key,mint.key,game.key,&[],settled.burned,g.decimals)?,&[vault.clone(),mint.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   sol_coverage(game,&g)?;token_coverage(vault,&g,game.key,tp.key)?;save(game,&g)?;save(pa,&p)
  },
  5|6=>{ // claim / withdraw unused: player owner, game, player, vault, destination token, mint, token program
   require(args.is_empty())?;let owner=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let vault=next_account_info(iter)?;let target=next_account_info(iter)?;let mint=next_account_info(iter)?;let tp=next_account_info(iter)?;
   let mut g=load_game(pid,game)?;let mut p=load_player(pid,pa,game.key)?;if g.core.closed(){require(owner.key.to_bytes()==p.player.key)?;}else{signer(owner,&Pubkey::new_from_array(p.player.key))?;}require(tp.key==mint.owner && tokens::supported_program(tp.key))?;mint_account(mint,&g)?;token_coverage(vault,&g,game.key,tp.key)?;tokens::account(target,&g.mint,owner.key,tp.key)?;
   let (tokens,sol)=if tag==5 {core(g.core.claim(&mut p.player))?}else{(core(g.core.withdraw_unused(&mut p.player))?,0)};
   if tokens>0{invoke_signed(&spl_token_2022::instruction::transfer_checked(tp.key,vault.key,mint.key,target.key,game.key,&[],tokens,g.decimals)?,&[vault.clone(),mint.clone(),target.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;}
   if sol>0{move_sol(game,owner,sol)?;}sol_coverage(game,&g)?;token_coverage(vault,&g,game.key,tp.key)?;save(game,&g)?;save(pa,&p)
  },
  7|8=>{ // deposit net collected fees / initial prize: funder, game, treasury, system
   let amount=u64arg(args)?;require(amount>0)?;let from=next_account_info(iter)?;let game=next_account_info(iter)?;let treasury=next_account_info(iter)?;let sys=next_account_info(iter)?;signer(from,from.key)?;let mut g=load_game(pid,game)?;
   require(!g.core.closed() && treasury.key==&g.treasury && sys.key==&system_program::id())?;
   invoke(&system_instruction::transfer(from.key,game.key,amount),&[from.clone(),game.clone(),sys.clone()])?;
   let pot=if tag==7 {(u128::from(amount)*9/10) as u64}else{amount};let treasury_amount=amount-pot;
   core(g.core.receive_jackpot(pot))?;if treasury_amount>0{move_sol(game,treasury,treasury_amount)?;}sol_coverage(game,&g)?;save(game,&g)
  },
  9=>{ // dev shutdown/sweep: dev, game. Repeated sweeps recover released pots and direct transfers.
   require(args.is_empty())?;let dev=next_account_info(iter)?;let game=next_account_info(iter)?;let mut g=load_game(pid,game)?;signer(dev,&g.owner)?;
   g.core.close_and_recover();let reserve=Rent::get()?.minimum_balance(game.data_len()).checked_add(core(g.core.protected_sol())?).ok_or(ProgramError::ArithmeticOverflow)?;
   let available=game.lamports().checked_sub(reserve).ok_or(ProgramError::InsufficientFunds)?;
   move_sol(game,dev,available)?;sol_coverage(game,&g)?;save(game,&g)
  },
  10=>{ // session grant/revoke: owner, game, player. key32 + expiry u64 + max spins u64
   require(args.len()==48)?;let owner=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let g=load_game(pid,game)?;let mut p=load_player(pid,pa,game.key)?;signer(owner,&Pubkey::new_from_array(p.player.key))?;
   let session=Pubkey::new_from_array(args[..32].try_into().unwrap());let expiry=u64arg(&args[32..40])?;let count=u64arg(&args[40..48])?;
   require(count<=10 && (count==0 || (!g.core.closed() && session!=Pubkey::default() && expiry>=Clock::get()?.slot && expiry<=Clock::get()?.slot.saturating_add(9000))))?;
   p.session=session;p.session_expiry=expiry;p.session_spins=count;save(pa,&p)
  },
  11=>{ // player reclaims THEIR account rent only when debts and pending spin are gone
   require(args.is_empty())?;let owner=next_account_info(iter)?;let game=next_account_info(iter)?;let pa=next_account_info(iter)?;let mut g=load_game(pid,game)?;let p=load_player(pid,pa,game.key)?;if g.core.closed(){require(owner.key.to_bytes()==p.player.key)?;}else{signer(owner,&Pubkey::new_from_array(p.player.key))?;}
   require(p.player.prepaid==0 && p.player.token_rewards==0 && p.player.sol_rewards==0 && g.core.pending().map_or(true,|s|s.player!=p.player.key))?;
   g.open_players=g.open_players.checked_sub(1).ok_or(ProgramError::ArithmeticOverflow)?;save(game,&g)?;move_sol(pa,owner,pa.lamports())?;pa.realloc(0,false)?;pa.assign(&system_program::id());Ok(())
  },
  12=>{ // retire: dev, game, token vault, dev token account, mint, token program
   require(args.is_empty())?;let dev=next_account_info(iter)?;let game=next_account_info(iter)?;let vault=next_account_info(iter)?;let target=next_account_info(iter)?;let mint=next_account_info(iter)?;let tp=next_account_info(iter)?;
   let fee_vault=next_account_info(iter)?;let native=spl_token::native_mint::id();let ata_program=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");let (expected_fee_vault,_)=Pubkey::find_program_address(&[game.key.as_ref(),spl_token::id().as_ref(),native.as_ref()],&ata_program);require(fee_vault.key==&expected_fee_vault && fee_vault.owner==&system_program::id() && fee_vault.data_is_empty() && fee_vault.lamports()==0)?;
   let g=load_game(pid,game)?;signer(dev,&g.owner)?;require(g.open_players==0 && g.open_oracles==0 && g.core.closed() && g.core.pending().is_none() && core(g.core.protected_sol())?==0 && core(g.core.protected_tokens())?==0 && tp.key==mint.owner && tokens::supported_program(tp.key))?;
   mint_account(mint,&g)?;token_coverage(vault,&g,game.key,tp.key)?;let balance=tokens::account(vault,&g.mint,game.key,tp.key)?.amount;tokens::account(target,&g.mint,dev.key,tp.key)?;
   if balance>0 {invoke_signed(&spl_token_2022::instruction::transfer_checked(tp.key,vault.key,mint.key,target.key,game.key,&[],balance,g.decimals)?,&[vault.clone(),mint.clone(),target.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;}
   invoke_signed(&spl_token_2022::instruction::close_account(tp.key,vault.key,dev.key,game.key,&[])?,&[vault.clone(),dev.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   move_sol(game,dev,game.lamports())?;game.realloc(0,false)?;game.assign(&system_program::id());Ok(())
  },
  13=>{ // unwrap fee WSOL and route actual receipts: game, WSOL ATA, treasury, dev, token program
   require(args.is_empty())?;let game=next_account_info(iter)?;let wsol=next_account_info(iter)?;let treasury=next_account_info(iter)?;let dev=next_account_info(iter)?;let tp=next_account_info(iter)?;let mut g=load_game(pid,game)?;
   require(treasury.key==&g.treasury && dev.key==&g.owner && tp.key==&spl_token::id())?;
   let native=spl_token::native_mint::id();let ata_program=solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");let (expected,_)=Pubkey::find_program_address(&[game.key.as_ref(),spl_token::id().as_ref(),native.as_ref()],&ata_program);require(wsol.key==&expected)?;
   tokens::account(wsol,&native,game.key,&spl_token::id())?;
   invoke(&spl_token::instruction::sync_native(tp.key,wsol.key)?,&[wsol.clone(),tp.clone()])?;
   let token=tokens::account(wsol,&native,game.key,&spl_token::id())?;let amount=token.amount;let rent=token.is_native.ok_or(ProgramError::InvalidAccountData)?;
   invoke_signed(&spl_token::instruction::close_account(tp.key,wsol.key,game.key,game.key,&[])?,&[wsol.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   if g.core.closed(){move_sol(game,dev,amount.checked_add(rent).ok_or(ProgramError::ArithmeticOverflow)?)?;}else{
    let pot=(u128::from(amount)*9/10) as u64;core(g.core.receive_jackpot(pot))?;if amount>pot{move_sol(game,treasury,amount-pot)?;}move_sol(game,dev,rent)?;
   }
   sol_coverage(game,&g)?;save(game,&g)
  },
  18=>{ // Permissionless, atomic Pump receipts: delegate only the dedicated fee WSOL.
   require(args.is_empty())?;let payer=next_account_info(iter)?;let game=next_account_info(iter)?;let source=next_account_info(iter)?;let temporary=next_account_info(iter)?;let native_mint=next_account_info(iter)?;let treasury=next_account_info(iter)?;let dev=next_account_info(iter)?;let sys=next_account_info(iter)?;let tp=next_account_info(iter)?;
   signer(payer,payer.key)?;let mut g=load_game(pid,game)?;
   require(tp.key==&spl_token::id() && sys.key==&system_program::id() && native_mint.key==&spl_token::native_mint::id() && treasury.key==&g.treasury && dev.key==&g.owner)?;
   tokens::delegated_fee_account(source,&g.owner,&g.mint,game.key)?;
   invoke(&spl_token::instruction::sync_native(tp.key,source.key)?,&[source.clone(),tp.clone()])?;
   let token=tokens::delegated_fee_account(source,&g.owner,&g.mint,game.key)?;let amount=token.amount;require(token.delegated_amount>=amount)?;
   if amount==0{return sol_coverage(game,&g)}
   let (expected,bump)=Pubkey::find_program_address(&[b"fee-crank",game.key.as_ref()],pid);require(temporary.key==&expected && temporary.owner==&system_program::id() && temporary.data_is_empty())?;
   let prefunded=temporary.lamports();let rent=Rent::get()?.minimum_balance(165);let rent_paid=rent.saturating_sub(prefunded);
   create_pda(payer,temporary,sys,tp.key,165,&[b"fee-crank",game.key.as_ref(),&[bump]])?;
   invoke(&spl_token::instruction::initialize_account3(tp.key,temporary.key,native_mint.key,game.key)?,&[temporary.clone(),native_mint.clone(),tp.clone()])?;
   invoke_signed(&spl_token::instruction::transfer(tp.key,source.key,temporary.key,game.key,&[],amount)?,&[source.clone(),temporary.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   invoke_signed(&spl_token::instruction::close_account(tp.key,temporary.key,game.key,game.key,&[])?,&[temporary.clone(),game.clone(),tp.clone()],&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   // Return precisely the caller's temporary rent. Prior unsolicited funding is
   // separate from receipts and goes to the dev, never through the 90/10 split.
   if rent_paid>0{move_sol(game,payer,rent_paid)?;}if prefunded>0{move_sol(game,dev,prefunded)?;}
   if g.core.closed(){move_sol(game,dev,amount)?;}else{let pot=(u128::from(amount)*9/10) as u64;core(g.core.receive_jackpot(pot))?;if amount>pot{move_sol(game,treasury,amount-pot)?;}}
   sol_coverage(game,&g)?;save(game,&g)
  },
  14|15|16=>{ // Exact Switchboard init/reveal/close CPI; never a generic PDA signer.
   if cfg!(feature="mainnet-orao") && tag!=16{return Err(ProgramError::InvalidInstructionData)}
   let actor=next_account_info(iter)?;let game=next_account_info(iter)?;let oracle=next_account_info(iter)?;let remaining=iter.as_slice();let mut g=load_game(pid,game)?;
   require(oracle.key==&g.oracle_program && oracle.executable && g.oracle_program!=orao::ID)?;signer(actor,actor.key)?;
   let discriminator: [u8;8]=match tag {
    14=>{signer(actor,&g.owner)?;require(!g.core.closed() && args.len()==8 && remaining.len()==13)?;require(remaining[2].key==game.key && remaining[3].key==&g.queue && remaining[4].key==actor.key)?;[9,9,204,33,50,116,113,15]},
    15=>{require(args.len()==97 && remaining.len()==12)?;let pending=g.core.pending().ok_or(ProgramError::InvalidArgument)?;require(remaining[0].key.to_bytes()==pending.oracle_request && remaining[4].key==game.key && remaining[5].key==actor.key)?;[197,181,187,10,30,58,20,73]},
    _=>{signer(actor,&g.owner)?;require(args.is_empty() && remaining.len()==10 && (g.core.closed() || (g.magic==PRELAUNCH_MAGIC && g.open_players==0)) && g.core.pending().is_none() && g.open_oracles>0 && remaining[2].key==game.key)?;[146,101,14,74,225,246,0,156]}
   };
   if tag!=14 {require(remaining[0].owner==oracle.key)?;let r=RandomnessAccountData::parse(remaining[0].try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;require(r.authority==*game.key && r.queue==g.queue)?;}
   let mut payload=discriminator.to_vec();payload.extend_from_slice(args);
   let metas=remaining.iter().map(|a|solana_program::instruction::AccountMeta{pubkey:*a.key,is_signer:a.is_signer || a.key==game.key,is_writable:a.is_writable}).collect();
   let ix=solana_program::instruction::Instruction{program_id:*oracle.key,accounts:metas,data:payload};
   invoke_signed(&ix,remaining,&[&[b"game",g.mint.as_ref(),&[g.bump]]])?;
   if tag==14 {require(remaining[0].owner==oracle.key)?;let r=RandomnessAccountData::parse(remaining[0].try_borrow_data()?).map_err(|_|ProgramError::InvalidAccountData)?;require(r.authority==*game.key && r.queue==g.queue)?;g.open_oracles=g.open_oracles.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;}
   if tag==16 {require(remaining[0].lamports()==0)?;g.open_oracles=g.open_oracles.checked_sub(1).ok_or(ProgramError::ArithmeticOverflow)?;}
   sol_coverage(game,&g)?;save(game,&g)
  },
  _=>Err(ProgramError::InvalidInstructionData)
 }
}

#[cfg(test)]
mod tests{
 use super::*;
 #[test]fn account_layout_capacity(){let g=GameAccount{magic:GAME_MAGIC,owner:Pubkey::new_unique(),treasury:Pubkey::new_unique(),mint:Pubkey::new_unique(),oracle_program:Pubkey::new_unique(),queue:Pubkey::new_unique(),bump:1,decimals:6,seed_slot:0,open_players:0,open_oracles:0,core:Game::new(6).unwrap()};let mut g=g;let mut p=Player::new([1;32]);g.core.receive_jackpot(1).unwrap();g.core.buy_pack(&mut p,1).unwrap();g.core.begin(&mut p,[2;32]).unwrap();assert!(borsh::to_vec(&g).unwrap().len()<=GAME_LEN);let p=PlayerAccount{magic:PLAYER_MAGIC,game:Pubkey::new_unique(),player:p,session:Pubkey::new_unique(),session_expiry:0,session_spins:0,bump:1,receipt:BatchReceipt::default()};assert!(borsh::to_vec(&p).unwrap().len()<=PLAYER_LEN);}
 #[test]fn batch_hash_vectors_and_legacy_padding(){
  let game=Pubkey::new_from_array([7;32]);
  assert_eq!(batch_draws(&[9;32],&game,3,77,10).unwrap(),[131,256,21,65,30,338,80,316,280,120]);
  assert_ne!(batch_draws(&[9;32],&game,3,77,10).unwrap(),batch_draws(&[9;32],&game,4,77,10).unwrap());
  assert!(batch_draws(&[9;32],&game,3,77,11).is_err());
  let mut value=[0u8;32];value[..4].copy_from_slice(&83u32.to_le_bytes());assert_eq!(batch_draws(&value,&game,3,77,1).unwrap()[0],84);
  let p=PlayerAccount{magic:PLAYER_MAGIC,game,player:Player::new([1;32]),session:Pubkey::default(),session_expiry:0,session_spins:0,bump:1,receipt:BatchReceipt::default()};
  let encoded=borsh::to_vec(&p).unwrap();assert_eq!(encoded.len(),223);
  let mut old=[0u8;PLAYER_LEN];old[..145].copy_from_slice(&encoded[..145]);let decoded=PlayerAccount::deserialize(&mut &old[..]).unwrap();assert_eq!(decoded.receipt.requested,0);assert_eq!(decoded.player,p.player);
  let mut g=Game::new(6).unwrap();g.receive_jackpot(100).unwrap();let mut player=Player::new([1;32]);g.buy_pack(&mut player,5).unwrap();g.begin(&mut player,[2;32]).unwrap();
  let encoded=borsh::to_vec(&g).unwrap();let mut old=[0u8;GAME_LEN];old[..encoded.len()-1].copy_from_slice(&encoded[..encoded.len()-1]);let legacy=Game::deserialize(&mut &old[..]).unwrap();assert_eq!(legacy.pending_count(),1);assert_eq!(legacy.protected_tokens(),g.protected_tokens());
 }
 #[test]fn signer_must_be_correct_and_sign(){let key=Pubkey::new_unique();let other=Pubkey::new_unique();let mut l=0;let mut d=[];let owner=system_program::id();let a=AccountInfo::new(&key,false,true,&mut l,&mut d,&owner,false,0);assert_eq!(signer(&a,&key),Err(ProgramError::MissingRequiredSignature));let mut a=a;a.is_signer=true;assert!(signer(&a,&other).is_err());assert!(signer(&a,&key).is_ok());}
}
