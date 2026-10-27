# Verification

`node verify/source.mjs` hashes the 122 files in the reviewed production export and the supplied game binary. The manifest is a project-published record, not independent attestation. The added README, docs, tests and verification scripts are outside that original export and are reviewed as part of this Git snapshot.

`node --test tests/*.test.mjs` runs nine published JavaScript checks for simulated launch sequencing, pending approvals, empty-pot and outage handling, same-origin admission, release identity and browser status gating. These tests do not execute a live token launch, an oracle quorum or a mainnet player payout. The earlier 297-test internal result and 16 local-program checks are historical results recorded separately; they must not be described as tests executed by this public workflow.

`node scripts/build-mainnet.mjs` builds the public website from this snapshot, including the randomness source excerpts. It does not start the signing worker or submit transactions. The server cannot operate without private material and its durable ledgers.

`node verify/mainnet.mjs` is optional and read-only. It verifies the mainnet genesis, the exact reviewed executable/program-data hashes and current game/fee-account identities using a public RPC. It fails when a pinned program has changed. Such a failure may indicate an upstream upgrade requiring review; do not blindly replace pins to make a check green. An alternate HTTPS RPC may be provided as the first argument.

You can separately download the deployed program with the Solana CLI and compare its SHA-256 to the artifact record. A matching binary hash identifies bytes. This repository does not claim that compiling the Rust source has independently reproduced those exact bytes.

The recorded ORAO health request was paid by the project, fulfilled on mainnet and received a finalized rent refund. It was not a customer spin and is not player-payout evidence. Verify its public signatures in the snapshot file using a Solana explorer.

The current token may not yet exist. Entry stays blocked until token properties, fee setup, activation, oracle availability and prize funding pass the live checks. Neither a static README nor the readiness endpoint is a guarantee about future state.
