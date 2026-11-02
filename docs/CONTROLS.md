# Operator controls and trust assumptions

The DEV retains upgrade authority and can close the game and recover unallocated funds. The current code reserves recorded player obligations.

The DEV owns a dedicated wrapped-SOL creator-fee account. Only that account is delegated to the game for fee ingestion; this is not delegation of the DEV wallet. Closing the game changes future fee ingestion behavior so recoverable funds can be returned to the DEV.

The automation wallet pays bounded operation costs and submits fixed settlement, collection and activation plans. It is not the DEV or treasury wallet and is not a general-purpose player-reward signer. Its operation still depends on the hosted worker, durable ledgers, RPC service, adequate gas, current program checks and the oracle provider. A service outage can delay results, claims or launch activation even when the accounting state is preserved.

Before entry, verify the mint, program, current authority, official domain and requested transaction in your wallet. The token, oracle and network costs are real. An entry can lose all its tokens. Publication, test results and self-funded health checks are not an independent security audit or a promise of future uptime or payouts.
