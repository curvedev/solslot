//! Accept ordinary SPL tokens and the metadata-only Token-2022 profile used by
//! Pump create_v2. Extensions which can tax, intercept, freeze, or seize entries
//! are deliberately unsupported. WSOL fee accounts always use legacy SPL Token.
use solana_program::{account_info::AccountInfo, program_error::ProgramError, program_pack::Pack, pubkey::Pubkey};
use spl_token_2022::{extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions}, state::{Account, Mint}};
use crate::require;

pub fn supported_program(program: &Pubkey) -> bool {
    *program == spl_token::id() || *program == spl_token_2022::id()
}

pub fn mint(account: &AccountInfo) -> Result<Mint, ProgramError> {
    require(supported_program(account.owner))?;
    let data = account.try_borrow_data()?;
    let mint = if *account.owner == spl_token::id() {
        Mint::unpack(&data)?
    } else {
        let state = StateWithExtensions::<Mint>::unpack(&data)?;
        require(state.get_extension_types()?.iter().all(|extension|
            matches!(extension, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata)))?;
        state.base
    };
    require(mint.decimals == 6 && mint.mint_authority.is_none() && mint.freeze_authority.is_none())?;
    Ok(mint)
}

pub fn account(account: &AccountInfo, mint: &Pubkey, owner: &Pubkey, program: &Pubkey) -> Result<Account, ProgramError> {
    require(supported_program(program) && account.owner == program)?;
    let data = account.try_borrow_data()?;
    let token = if *program == spl_token::id() {
        Account::unpack(&data)?
    } else {
        let state = StateWithExtensions::<Account>::unpack(&data)?;
        require(state.get_extension_types()?.iter().all(|extension| *extension == ExtensionType::ImmutableOwner))?;
        state.base
    };
    require(token.mint == *mint && token.owner == *owner && token.delegate.is_none()
        && token.close_authority.is_none() && !token.is_frozen())?;
    Ok(token)
}

// A separate, dev-owned legacy WSOL account receives native Pump fee shares.
// The dev can revoke this delegation or recover/close/recreate the account even
// after the game program is retired. It never delegates the dev's wallet SOL.
pub fn delegated_fee_account(account: &AccountInfo, owner: &Pubkey, mint: &Pubkey, delegate: &Pubkey) -> Result<Account, ProgramError> {
    use solana_program::program_option::COption;
    let seed = mint.to_string();
    let expected = Pubkey::create_with_seed(owner, &seed[..32], &spl_token::id())?;
    require(account.key == &expected && account.owner == &spl_token::id())?;
    let token = Account::unpack(&account.try_borrow_data()?)?;
    require(token.mint == spl_token::native_mint::id() && token.owner == *owner
        && token.delegate == COption::Some(*delegate) && token.close_authority.is_none()
        && token.is_native.is_some() && !token.is_frozen())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::program_option::COption;
    use spl_token_2022::{extension::{BaseStateWithExtensionsMut, StateWithExtensionsMut,
        metadata_pointer::MetadataPointer, permanent_delegate::PermanentDelegate,
        transfer_fee::TransferFeeConfig, immutable_owner::ImmutableOwner,
        memo_transfer::MemoTransfer}, state::AccountState};

    fn mint_data(extension: ExtensionType) -> Vec<u8> {
        let mut data = vec![0; ExtensionType::try_calculate_account_len::<Mint>(&[extension]).unwrap()];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
        match extension {
            ExtensionType::MetadataPointer => { state.init_extension::<MetadataPointer>(false).unwrap(); },
            ExtensionType::PermanentDelegate => { state.init_extension::<PermanentDelegate>(false).unwrap(); },
            ExtensionType::TransferFeeConfig => { state.init_extension::<TransferFeeConfig>(false).unwrap(); },
            _ => unreachable!(),
        }
        state.base = Mint { decimals:6, is_initialized:true, ..Mint::default() };
        state.pack_base(); state.init_account_type().unwrap(); data
    }

    #[test]
    fn only_the_dedicated_native_fee_account_can_be_delegated() {
        let owner=Pubkey::new_unique(); let mint=Pubkey::new_unique(); let delegate=Pubkey::new_unique();
        let program=spl_token::id(); let seed=mint.to_string();
        let key=Pubkey::create_with_seed(&owner,&seed[..32],&program).unwrap();
        let base=Account{mint:spl_token::native_mint::id(),owner,amount:42,
            delegate:COption::Some(delegate),state:AccountState::Initialized,
            is_native:COption::Some(2039280),delegated_amount:42,close_authority:COption::None};
        for mutation in 0..8 {
            let mut value=base;
            match mutation {
                1=>value.owner=mint, 2=>value.mint=mint,
                3=>value.delegate=COption::None, 4=>value.delegate=COption::Some(owner),
                5=>value.is_native=COption::None, 6=>value.state=AccountState::Frozen,
                7=>value.close_authority=COption::Some(owner), _=>(),
            }
            let mut data=vec![0;Account::LEN]; Account::pack(value,&mut data).unwrap();
            let mut lamports=2039322;
            let info=AccountInfo::new(&key,false,true,&mut lamports,&mut data,&program,false,0);
            assert_eq!(delegated_fee_account(&info,&owner,&mint,&delegate).is_ok(),mutation==0);
            if mutation==0 {
                // Ordinary token validation must still reject this delegation.
                assert!(account(&info,&value.mint,&owner,&program).is_err());
                let wrong=AccountInfo::new(&owner,false,true,&mut lamports,&mut data,&program,false,0);
                assert!(delegated_fee_account(&wrong,&owner,&mint,&delegate).is_err());
            }
        }
    }

    #[test]
    fn metadata_only_mints_and_revoked_authorities() {
        let key=Pubkey::new_unique(); let owner=spl_token_2022::id(); let mut lamports=1;
        for extension in [ExtensionType::MetadataPointer, ExtensionType::PermanentDelegate, ExtensionType::TransferFeeConfig] {
            let mut data=mint_data(extension);
            let info=AccountInfo::new(&key,false,false,&mut lamports,&mut data,&owner,false,0);
            assert_eq!(mint(&info).is_ok(), extension==ExtensionType::MetadataPointer);
        }
        let mut data=mint_data(ExtensionType::MetadataPointer);
        let mut state=StateWithExtensionsMut::<Mint>::unpack(&mut data).unwrap();
        state.base.mint_authority=COption::Some(key); state.pack_base();
        assert!(mint(&AccountInfo::new(&key,false,false,&mut lamports,&mut data,&owner,false,0)).is_err());
        let mut state=StateWithExtensionsMut::<Mint>::unpack(&mut data).unwrap();
        state.base.mint_authority=COption::None; state.base.freeze_authority=COption::Some(key); state.pack_base();
        assert!(mint(&AccountInfo::new(&key,false,false,&mut lamports,&mut data,&owner,false,0)).is_err());
    }

    #[test]
    fn accounts_pin_program_owner_and_reject_behaviour_extensions() {
        let key=Pubkey::new_unique(); let owner=Pubkey::new_unique(); let mint=Pubkey::new_unique();
        let program=spl_token_2022::id(); let mut lamports=1;
        for extension in [ExtensionType::ImmutableOwner, ExtensionType::MemoTransfer] {
            let mut data=vec![0;ExtensionType::try_calculate_account_len::<Account>(&[extension]).unwrap()];
            let mut state=StateWithExtensionsMut::<Account>::unpack_uninitialized(&mut data).unwrap();
            if extension==ExtensionType::ImmutableOwner {state.init_extension::<ImmutableOwner>(false).unwrap();}
            else {state.init_extension::<MemoTransfer>(false).unwrap();}
            state.base=Account{mint,owner,state:AccountState::Initialized,..Account::default()};
            state.pack_base(); state.init_account_type().unwrap();
            let info=AccountInfo::new(&key,false,false,&mut lamports,&mut data,&program,false,0);
            assert_eq!(account(&info,&mint,&owner,&program).is_ok(),extension==ExtensionType::ImmutableOwner);
            assert!(account(&info,&mint,&owner,&spl_token::id()).is_err());
            assert!(account(&info,&mint,&key,&program).is_err());
        }
    }
}
