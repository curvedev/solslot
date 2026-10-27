# Randomness and pack settlement

A paid pack commits a fresh ORAO RequestV2 account atomically with its token entry. The on-chain wrapper checks the expected oracle program, network, request PDA, client, seed, account format and fulfillment. A previously fulfilled request cannot be substituted for a fresh entry. The dedicated operator health request is separate and never supplies a player's pack result.

The program hashes the authenticated fulfilled output into its randomness input. One-spin entries derive a draw from those authenticated bytes. Multi-spin packs derive separate deterministic hashes for each spin using the committed context. The actual implementation and domain separation are in `batch_draws` in [the on-chain wrapper](../programs/game-program/src/lib.rs).

A uniform 32-bit word is converted to a draw from 1 through 400 by rejection sampling. The largest multiple of 400 below 2^32 is 4,294,967,200. Words at or above that value are rejected, rather than reduced with a biased modulo. Retry counters use the same authenticated output; they do not request a new seed to reroll a loss.

Draws 1–4 award the reserved SOL jackpot. Draws 5–84 award the full token entry back, split into four visual matching categories of 20 draws each. Draws 85–400 lose the token entry. The core records burns, claimable rewards and returned unused credits together. A jackpot stops subsequent entries in the pack.

The cabinet animation displays the accepted result. Refreshing does not choose different draws. An uncertain transaction is reconciled by its known signature and durable state before another attempt can be made. A timeout by itself is not proof that an accepted entry may be refunded or rerolled.

Oracle quorum operation, Solana consensus, RPC responses and continued availability are dependencies. Source review can verify these checks and calculations; it cannot guarantee provider uptime or eliminate the upgrade authority described in [operator controls](CONTROLS.md).
