//! Deterministic accounting core for the Solana port, NOT a deployable program.
//! The sibling game-program crate provides account, signer, CPI and oracle checks.
//! Keep this core independently testable; it never authorizes a caller.
#![no_std]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error { Overflow, Closed, Busy, EmptyPot, InvalidPack, InsufficientCredits, NoSpin, WrongSpin, InvalidDraw }
type Result<T> = core::result::Result<T, Error>;
fn add(a: u64, b: u64) -> Result<u64> { a.checked_add(b).ok_or(Error::Overflow) }

#[cfg_attr(feature = "serialization", derive(borsh::BorshSerialize, borsh::BorshDeserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Player {
    pub key: [u8; 32],
    pub prepaid: u64,
    pub token_rewards: u64,
    pub sol_rewards: u64,
}
impl Player {
    pub fn new(key: [u8; 32]) -> Self { Self { key, prepaid: 0, token_rewards: 0, sol_rewards: 0 } }
}
#[cfg_attr(feature = "serialization", derive(borsh::BorshSerialize, borsh::BorshDeserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spin { pub nonce: u64, pub player: [u8; 32], pub oracle_request: [u8; 32], pub locked_pot: u64 }
#[cfg_attr(feature = "serialization", derive(borsh::BorshSerialize, borsh::BorshDeserialize))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement { pub burned: u64, pub tokens: u64, pub sol: u64 }

#[cfg_attr(feature = "serialization", derive(borsh::BorshSerialize, borsh::BorshDeserialize))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Game {
    entry: u64,
    pot: u64,
    pending: Option<Spin>,
    next_nonce: u64,
    token_liability: u64,
    sol_liability: u64,
    prepaid_liability: u64,
    burned: u64,
    closed: bool,
    // Appended into existing account padding; zero means a legacy single spin.
    pending_count: u8,
    // Appended into zero padding. Existing games retain their half-back rule.
    full_back: bool,
}
impl Game {
    pub fn new(decimals: u32) -> Result<Self> {
        let scale = 10u64.checked_pow(decimals).ok_or(Error::Overflow)?;
        let entry = 50_000u64.checked_mul(scale).ok_or(Error::Overflow)?;
        Ok(Self { entry, pot: 0, pending: None, next_nonce: 1, token_liability: 0, sol_liability: 0, prepaid_liability: 0, burned: 0, closed: false, pending_count: 0, full_back: true })
    }
    /// Wrapper must restrict this to a never-activated reservation. No existing
    /// player credit, accepted draw or earned reward can be repriced.
    pub fn configure_prelaunch_rules(&mut self, decimals: u32) -> Result<()> {
        if self.closed { return Err(Error::Closed); }
        if self.pending.is_some() || self.next_nonce != 1 || self.token_liability != 0 || self.sol_liability != 0 || self.prepaid_liability != 0 || self.burned != 0 || self.pending_count != 0 { return Err(Error::Busy); }
        let scale = 10u64.checked_pow(decimals).ok_or(Error::Overflow)?;
        self.entry = 50_000u64.checked_mul(scale).ok_or(Error::Overflow)?;
        self.full_back = true;
        Ok(())
    }
    pub fn entry(&self) -> u64 { self.entry }
    pub fn consolation(&self) -> u64 { if self.full_back { self.entry } else { self.entry/2 } }
    pub fn closed(&self) -> bool { self.closed }
    pub fn accounted_sol(&self) -> Result<u64> { add(self.pot, self.protected_sol()?) }
    pub fn pot(&self) -> u64 { self.pot }
    pub fn pending(&self) -> Option<Spin> { self.pending }
    pub fn pending_count(&self) -> u8 { if self.pending.is_some() { self.pending_count.max(1) } else { 0 } }
    pub fn burned(&self) -> u64 { self.burned }

    /// Call only after an on-chain wrapper reconciles genuinely received SOL.
    /// Inflow during a pending spin belongs to the NEXT pot.
    pub fn receive_jackpot(&mut self, lamports: u64) -> Result<()> {
        self.pot = add(self.pot, lamports)?; Ok(())
    }
    /// Returns tokens the wrapper must transfer to escrow atomically.
    pub fn buy_pack(&mut self, player: &mut Player, count: u64) -> Result<u64> {
        if self.closed { return Err(Error::Closed); }
        if ![1, 5, 10].contains(&count) { return Err(Error::InvalidPack); }
        let amount = self.entry.checked_mul(count).ok_or(Error::Overflow)?;
        let balance = add(player.prepaid, amount)?;
        let total = add(self.prepaid_liability, amount)?;
        player.prepaid = balance; self.prepaid_liability = total; Ok(amount)
    }
    /// Only owner-authorized transfers may call this in the eventual wrapper.
    pub fn withdraw_unused(&mut self, player: &mut Player) -> Result<u64> {
        let amount = player.prepaid;
        let remaining = self.prepaid_liability.checked_sub(amount).ok_or(Error::InsufficientCredits)?;
        player.prepaid = 0; self.prepaid_liability = remaining; Ok(amount)
    }
    /// A session authority may consume an entry but cannot change its beneficiary.
    pub fn begin(&mut self, player: &mut Player, oracle_request: [u8; 32]) -> Result<Spin> {
        self.begin_batch(player, oracle_request, 1)
    }
    pub fn begin_batch(&mut self, player: &mut Player, oracle_request: [u8; 32], count: u8) -> Result<Spin> {
        if !(1..=10).contains(&count) { return Err(Error::InvalidPack); }
        if self.closed { return Err(Error::Closed); }
        if self.pending.is_some() { return Err(Error::Busy); }
        if self.pot == 0 { return Err(Error::EmptyPot); }
        let reserved = self.entry.checked_mul(u64::from(count)).ok_or(Error::Overflow)?;
        let balance = player.prepaid.checked_sub(reserved).ok_or(Error::InsufficientCredits)?;
        let liability = self.prepaid_liability.checked_sub(reserved).ok_or(Error::InsufficientCredits)?;
        let next_nonce = add(self.next_nonce, 1)?;
        let spin = Spin { nonce: self.next_nonce, player: player.key, oracle_request, locked_pot: self.pot };
        player.prepaid = balance; self.prepaid_liability = liability;
        self.pot = 0; self.pending = Some(spin); self.next_nonce = next_nonce; self.pending_count = count;
        Ok(spin)
    }
    fn matching_spin(&self, player: &Player, nonce: u64, request: [u8; 32]) -> Result<Spin> {
        let spin = self.pending.ok_or(Error::NoSpin)?;
        if spin.nonce != nonce || spin.oracle_request != request || spin.player != player.key { return Err(Error::WrongSpin); }
        Ok(spin)
    }
    /// `number` is an already authenticated, unbiased 1..=400 draw.
    /// NEVER expose this raw-number method directly as an on-chain instruction.
    pub fn settle_verified(&mut self, player: &mut Player, nonce: u64, request: [u8; 32], number: u16) -> Result<Settlement> {
        self.settle_batch_verified(player, nonce, request, &[number]).map(|(result, _)| result)
    }
    /// The wrapper derives every draw from one authenticated oracle output.
    /// A jackpot ends this pack and releases its unplayed entries as credits.
    pub fn settle_batch_verified(&mut self, player: &mut Player, nonce: u64, request: [u8;32], numbers: &[u16]) -> Result<(Settlement,u8)> {
        let spin = self.matching_spin(player, nonce, request)?;
        let count = self.pending_count();
        if numbers.len()!=usize::from(count) || numbers.iter().any(|n| !(1..=400).contains(n)) { return Err(Error::InvalidDraw); }
        let mut tokens=0; let mut sol=0; let mut burned=0; let mut played=0u8;
        for number in numbers {
            let reward=if (5..=84).contains(number) { self.consolation() } else { 0 };
            tokens=add(tokens,reward)?; burned=add(burned,self.entry-reward)?; played+=1;
            if *number<=4 { sol=spin.locked_pot; break; }
        }
        let unused=self.entry.checked_mul(u64::from(count-played)).ok_or(Error::Overflow)?;
        let new_pot=add(self.pot,if sol==0 {spin.locked_pot} else {0})?;
        let new_tokens=add(player.token_rewards,tokens)?; let new_sol=add(player.sol_rewards,sol)?;
        let token_liability=add(self.token_liability,tokens)?; let sol_liability=add(self.sol_liability,sol)?;
        let total_burned=add(self.burned,burned)?; let prepaid=add(player.prepaid,unused)?;
        let prepaid_liability=add(self.prepaid_liability,unused)?;
        self.pot=new_pot; player.token_rewards=new_tokens; player.sol_rewards=new_sol; player.prepaid=prepaid;
        self.token_liability=token_liability; self.sol_liability=sol_liability; self.prepaid_liability=prepaid_liability;
        self.burned=total_burned; self.pending=None; self.pending_count=0;
        Ok((Settlement{burned,tokens,sol},played))
    }
    /// Wrapper must prove oracle invalidation, not merely observe a timeout.
    /// An unverified timeout must never allow choosing a refund over a loss.
    pub fn refund_invalidated(&mut self, player: &mut Player, nonce: u64, request: [u8; 32]) -> Result<()> {
        let spin = self.matching_spin(player, nonce, request)?;
        let pot = add(self.pot, spin.locked_pot)?;
        let reserved=self.entry.checked_mul(u64::from(self.pending_count())).ok_or(Error::Overflow)?;
        let balance = add(player.prepaid, reserved)?;
        let liability = add(self.prepaid_liability, reserved)?;
        self.pot = pot; player.prepaid = balance; self.prepaid_liability = liability; self.pending = None; self.pending_count=0; Ok(())
    }
    /// Wrapper authorizes the player and sends only to the player's fixed account.
    pub fn claim(&mut self, player: &mut Player) -> Result<(u64, u64)> {
        let tokens = self.token_liability.checked_sub(player.token_rewards).ok_or(Error::Overflow)?;
        let sol = self.sol_liability.checked_sub(player.sol_rewards).ok_or(Error::Overflow)?;
        let payout = (player.token_rewards, player.sol_rewards);
        self.token_liability = tokens; self.sol_liability = sol;
        player.token_rewards = 0; player.sol_rewards = 0; Ok(payout)
    }
    /// Wrapper requires owner and sends only the uncommitted pot to the pinned owner.
    pub fn close_and_recover(&mut self) -> u64 {
        self.closed = true; let amount = self.pot; self.pot = 0; amount
    }
    pub fn protected_sol(&self) -> Result<u64> { add(self.sol_liability, self.pending.map_or(0, |s| s.locked_pot)) }
    pub fn protected_tokens(&self) -> Result<u64> { add(add(self.token_liability, self.prepaid_liability)?, self.entry.checked_mul(u64::from(self.pending_count())).ok_or(Error::Overflow)?) }
}

/// Rejection sampling of an authenticated uniform u32. Rejected words require
/// more bytes from the SAME committed oracle output, never a fresh oracle request.
pub fn draw_from_word(word: u32) -> Option<u16> {
    const LIMIT: u64 = (1u64 << 32) / 400 * 400;
    if u64::from(word) >= LIMIT { None } else { Some((word % 400 + 1) as u16) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn legacy_rules_survive_and_only_empty_reservations_can_change() {
        let mut legacy=Game::new(6).unwrap();legacy.entry=200_000_000_000;legacy.full_back=false;
        assert_eq!(legacy.consolation(),100_000_000_000);
        let mut p=Player::new([1;32]);let mut used=legacy.clone();used.buy_pack(&mut p,1).unwrap();
        let before=used.clone();assert_eq!(used.configure_prelaunch_rules(6),Err(Error::Busy));assert_eq!(used,before);
        used.withdraw_unused(&mut p).unwrap();used.receive_jackpot(1).unwrap();used.buy_pack(&mut p,1).unwrap();let s=used.begin(&mut p,[2;32]).unwrap();
        used.settle_verified(&mut p,s.nonce,[2;32],5).unwrap();assert_eq!(p.token_rewards,100_000_000_000);
        assert_eq!(used.configure_prelaunch_rules(6),Err(Error::Busy));
        legacy.configure_prelaunch_rules(6).unwrap();assert_eq!(legacy.entry(),50_000_000_000);assert_eq!(legacy.consolation(),50_000_000_000);
        legacy.receive_jackpot(1).unwrap();legacy.buy_pack(&mut p,1).unwrap();let s=legacy.begin(&mut p,[3;32]).unwrap();
        let r=legacy.settle_verified(&mut p,s.nonce,[3;32],84).unwrap();assert_eq!((r.tokens,r.burned),(50_000_000_000,0));
    }
    fn funded() -> (Game, Player) {
        let mut game = Game::new(6).unwrap(); let mut player = Player::new([1;32]);
        game.receive_jackpot(1_000_000_000).unwrap(); game.buy_pack(&mut player, 5).unwrap(); (game, player)
    }
    #[test] fn exhaustive_outcomes_conserve_entries_and_sol() {
        let (mut jackpots, mut halfbacks, mut losses) = (0,0,0);
        for draw in 1..=400 {
            let (mut g, mut p) = funded(); let s = g.begin(&mut p, [7;32]).unwrap();
            let result = g.settle_verified(&mut p,s.nonce,[7;32],draw).unwrap();
            assert_eq!(result.burned + result.tokens,g.entry());
            assert_eq!(g.pot()+g.protected_sol().unwrap(),1_000_000_000);
            assert_eq!(g.protected_tokens().unwrap()+g.burned(),g.entry()*5);
            if result.sol>0 {jackpots+=1} else if result.tokens>0 {halfbacks+=1} else {losses+=1}
        }
        assert_eq!((jackpots,halfbacks,losses),(4,80,316));
    }
    #[test] fn accepted_prize_survives_closure_and_late_fees() {
        let (mut g, mut p)=funded(); let s=g.begin(&mut p,[7;32]).unwrap();
        g.receive_jackpot(123).unwrap(); assert_eq!(g.close_and_recover(),123);
        assert_eq!(g.protected_sol().unwrap(),1_000_000_000);
        g.settle_verified(&mut p,s.nonce,[7;32],1).unwrap();
        assert_eq!(g.claim(&mut p).unwrap(),(0,1_000_000_000));
        assert_eq!(g.claim(&mut p).unwrap(),(0,0));
        assert_eq!(g.withdraw_unused(&mut p).unwrap(),g.entry()*4);
        assert_eq!(g.buy_pack(&mut p,1),Err(Error::Closed));
    }
    #[test] fn wrong_player_request_nonce_and_duplicate_cannot_settle() {
        let (mut g, mut p)=funded(); let s=g.begin(&mut p,[7;32]).unwrap();
        let mut other=Player::new([2;32]); let before=g.clone();
        assert_eq!(g.settle_verified(&mut other,s.nonce,[7;32],1),Err(Error::WrongSpin));
        assert_eq!(g.settle_verified(&mut p,s.nonce+1,[7;32],1),Err(Error::WrongSpin));
        assert_eq!(g.settle_verified(&mut p,s.nonce,[8;32],1),Err(Error::WrongSpin));
        assert_eq!(g,before); g.settle_verified(&mut p,s.nonce,[7;32],400).unwrap();
        assert_eq!(g.settle_verified(&mut p,s.nonce,[7;32],1),Err(Error::NoSpin));
    }
    #[test] fn pending_spin_is_serial_and_invalidated_refund_is_exact() {
        let (mut g,mut p)=funded();let balance=p.prepaid;let s=g.begin(&mut p,[7;32]).unwrap();
        assert_eq!(g.begin(&mut p,[9;32]),Err(Error::Busy));
        g.refund_invalidated(&mut p,s.nonce,[7;32]).unwrap();
        assert_eq!(p.prepaid,balance);assert_eq!(g.pot(),1_000_000_000);assert_eq!(g.burned(),0);
        assert_eq!(g.refund_invalidated(&mut p,s.nonce,[7;32]),Err(Error::NoSpin));
    }
    #[test] fn overflow_does_not_partially_change_state() {
        let (mut g,mut p)=funded();p.prepaid=u64::MAX;let before=g.clone();let player_before=p;
        assert_eq!(g.buy_pack(&mut p,1),Err(Error::Overflow));assert_eq!(g,before);assert_eq!(p,player_before);
        assert_eq!(Game::new(20),Err(Error::Overflow));
    }
    #[test] fn batch_conserves_every_entry_and_stops_at_first_jackpot() {
        for jackpot in 0..=10 {
            let mut g=Game::new(6).unwrap(); let mut p=Player::new([1;32]);
            g.receive_jackpot(1000).unwrap();g.buy_pack(&mut p,10).unwrap();
            let before=g.protected_tokens().unwrap(); let spin=g.begin_batch(&mut p,[2;32],10).unwrap();
            assert_eq!(g.protected_tokens().unwrap(),before);assert_eq!(p.prepaid,0);
            let mut draws=[5;10];if jackpot<10 {draws[jackpot]=1;}
            g.receive_jackpot(99).unwrap();g.close_and_recover();
            let (result,played)=g.settle_batch_verified(&mut p,spin.nonce,[2;32],&draws).unwrap();
            assert_eq!(usize::from(played),if jackpot<10 {jackpot+1} else {10});
            assert_eq!(g.burned()+g.protected_tokens().unwrap(),before);
            assert_eq!(g.pot()+g.protected_sol().unwrap(),1000);
            assert_eq!(p.prepaid,g.entry()*u64::from(10-played));
            assert_eq!(result.sol,if jackpot<10 {1000} else {0});
            assert_eq!(g.pending_count(),0);
        }
    }
    #[test] fn batch_validation_and_invalidation_never_partially_consume() {
        let (mut g,mut p)=funded();let before=g.clone();let player=p;
        for count in [0,6,11] {assert!(g.begin_batch(&mut p,[7;32],count).is_err());assert_eq!(g,before);assert_eq!(p,player);}
        let s=g.begin_batch(&mut p,[7;32],5).unwrap();let accepted=g.clone();let reserved=p;
        for draws in [&[1u16][..],&[5,5,5,5,401][..]] {assert!(g.settle_batch_verified(&mut p,s.nonce,[7;32],draws).is_err());assert_eq!(g,accepted);assert_eq!(p,reserved);}
        g.refund_invalidated(&mut p,s.nonce,[7;32]).unwrap();assert_eq!(p,player);assert_eq!(g.protected_tokens().unwrap(),before.protected_tokens().unwrap());
    }
    #[test] fn randomness_rejects_biased_tail() {
        assert_eq!(draw_from_word(0),Some(1));assert_eq!(draw_from_word(399),Some(400));
        assert_eq!(draw_from_word(4_294_967_199),Some(400));assert_eq!(draw_from_word(4_294_967_200),None);
        assert_eq!(draw_from_word(u32::MAX),None);
    }
}
