# SolSlot

A Solana slot game with oracle-derived results, token burns and a SOL jackpot funded by collected creator fees.

[Play SolSlot](https://solslot.fun/) · [Project X](https://x.com/playSolSlot) · [Read the randomness code](programs/game-program/src/orao.rs) · [Verification snapshot](docs/verification-snapshot.json)

This repository publishes a clean source snapshot for review. It is **not an independent audit, a guarantee of returns, or proof of a reproducible binary build**. The program remains upgradeable. Read the [operator controls and trust assumptions](docs/CONTROLS.md).

## Game rules

Each spin costs **50,000 SLOT**, plus SOL for randomness, network fees and any required account deposits. A pack contains 1, 5 or 10 spins and uses one wallet approval. Results settle before the animations display them; animation timing does not determine a result.

| Result per spin | Probability | Accounting |
| --- | ---: | --- |
| Three gold Solana symbols | 1% | Win the SOL pot reserved for that pack; burn the played spin's 50,000 SLOT entry |
| Three matching Pepe, Doge, Bitcoin or Pump.fun symbols | 20% combined; 5% each | Save the full 50,000 SLOT entry as a claimable token reward; no entry tokens burn on that match |
| No matching triple | 79% | No reward; burn the played spin's 50,000 SLOT entry |

A jackpot ends the pack. Unplayed entries become refundable credits. Refreshing stops local animation playback; it does not reroll or cancel an accepted on-chain result. Earned rewards remain claimable. SOL transaction and oracle fees are not returned by a consolation match.

**90% of creator-fee revenue actually collected by this project funds the pot; 10% goes to treasury.** Pump sets the fee schedule. These shares are percentages of received creator fees, not percentages of every trade. Unrelated pools do not fund this game. Admission waits for a funded pot and successful launch and randomness checks.

## What to inspect

| Question | Source |
| --- | --- |
| How are oracle accounts and results authenticated? | [ORAO on-chain checks](programs/game-program/src/orao.rs), [client checks](src/orao-vrf.js) |
| How are the odds, burns and liabilities calculated? | [Deterministic accounting core](programs/game-core/src/lib.rs) |
| Can a retry pick a different result? | [Request and settlement instructions](programs/game-program/src/lib.rs), [recovery worker](src/mainnet-settler.js) |
| How are creator fees collected and split? | [Pump account validation](src/pump-fees.js), [collection plans](src/solana-launch.js), [on-chain ingestion](programs/game-program/src/lib.rs) |
| What happens at token launch? | [Launch coordinator](src/prelaunch-coordinator.js), [fixed approval broadcaster](src/prelaunch-broadcast.js) |
| What can the operator do? | [Controls and trust assumptions](docs/CONTROLS.md) |
| Does this source match the published snapshot? | [Source verifier](verify/source.mjs), [production file hashes](verify/production-source-manifest.json) |

See [randomness and pack settlement](docs/RANDOMNESS.md) and [verification instructions](docs/VERIFY.md).

## Public identities

| Role | Address |
| --- | --- |
| Planned SLOT mint | `FuuTBe4PPsWH57Z6HfqxxMHPUuiHefd7WKUcLcz1SLoT` |
| Game program | `BBHgCoTRcop7txYHAAyBNvv5cVmVATppvFfaTXkp9QL9` |
| DEV / upgrade authority / creator wallet | `9vTBKH79nsZ8fwLhLRPAjECKk4mASTa5mwUPkNpAjtRE` |
| Treasury | `En1qbTpmpGG1CChPrftLrcDN15hY9ZKfoYceG1wSVas4` |
| Automation fee payer | `F49Wx6VGU4sxFejCXhBA2iUTrUDDuiD8YnQdCnfZvMfw` |

The mint had not been created at the snapshot check. A planned address is not evidence that the token has launched. Check [live status](https://solslot.fun/api/mainnet/status) and the chain independently.

## Run the public checks

Use Node.js 24:

```sh
npm ci --ignore-scripts
node --test tests/*.test.mjs
node verify/source.mjs
node scripts/build-mainnet.mjs
```

Optional **read-only** mainnet verification:

```sh
node verify/mainnet.mjs
```

These commands do not load a wallet or spend SOL. The build prepares static files; it does not launch a token or deploy a program. The production server requires separate private signing material and durable ledgers, which are intentionally absent. The Rust files are the reviewed source snapshot; the original SBF toolchain and a proven bit-for-bit reproduction procedure are not supplied.

## Scope and attribution

This is a new anonymous Git history containing the reviewed production-source export plus documentation and public checks. No wallet private keys, signed future transaction capabilities, expense ledgers, deployment credentials or private Git history are included.

Third-party notices remain in [web-source/THIRD_PARTY_NOTICES.txt](web-source/THIRD_PARTY_NOTICES.txt), the font license files, asset credits and generated bundle notices. This publication does not grant a new blanket license over third-party code or artwork. No additional license for original project code is specified here.
