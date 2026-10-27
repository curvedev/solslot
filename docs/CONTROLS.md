# Operator controls and trust assumptions

The program is upgradeable. Its DEV upgrade authority can replace the deployed program; reviewing this source snapshot does not prove that future code will retain these protections. Compare the current program data and binary hash independently.

In the published implementation, the DEV wallet can permanently close the current game to new entries and recover the unallocated pot and excess SOL. The shutdown instruction reserves rent, recorded SOL reward liabilities and the pot already locked for a pending pack. It does not authorize withdrawing a player's recorded rewards. Claims, accepted-result settlement and unused-credit recovery remain separate operations. Final account retirement requires closure, no open player/oracle accounts, no pending pack and no protected SOL or token liabilities.

The DEV owns a dedicated wrapped-SOL creator-fee account. Only that account is delegated to the game for fee ingestion; this is not delegation of the DEV wallet. Closing the game changes future fee ingestion behavior so recoverable funds can be returned to the DEV.

The automation wallet pays bounded operation costs and submits fixed settlement, collection and activation plans. It is not the DEV or treasury wallet and is not a general-purpose player-reward signer. Its operation still depends on the hosted worker, durable ledgers, RPC service, adequate gas, current program checks and the oracle provider. A service outage can delay results, claims or launch activation even when the accounting state is preserved.

Before entry, verify the mint, program, current authority, official domain and requested transaction in your wallet. The token, oracle and network costs are real. An entry can lose all its tokens. Publication, test results and self-funded health checks are not an independent security audit or a promise of future uptime or payouts.
