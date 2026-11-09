# $GRIND — Agent Utility Memecoin on NEAR

> Track: **Memecoins With Mechanics** — NEAR Hackathon

$GRIND is a NEP-141 memecoin where the meme *is* the mechanic: every transfer
burns, agents stake their reputation, bad agents get slashed by their peers,
and once a week the community runs a **ritual** that burns treasury if the
grind is real.

## Mechanics

| Mechanic | How it works |
|---|---|
| 🔥 **Burn on transfer** | 0.5% of every `ft_transfer` / `ft_transfer_call` is burned. `ft_total_supply` actually goes down and an `ft_burn` event is emitted. |
| 🤖 **Agent staking** | Stake ≥ 100 GRIND to become an agent. Reputation = `stake / 100 GRIND − slash_count`. Staked tokens sit in the contract vault. A slash can leave the remaining stake below 100; the account stays an agent and keeps its reputation, but it cannot file reports until it tops up to 100 again. |
| ⚖️ **Peer slashing (quorum)** | Agents report misbehaving agents with evidence. When **3 different agents** report the same target within **3 days**, 10% of its stake is slashed: half burned, half to the treasury. 7-day cooldown per target. Reporters must have staked for ≥ 1 day. A reported agent cannot unstake until the report window expires; if it expires without quorum, the target gets a 1-day grace period before a new report round can start. A partial unstake does not cancel that grace. `unstake_agent` requires 1 yoctoNEAR. A report does not lock the reporter's stake afterward. |
| 🕯️ **Weekly ritual** | Anyone can call `trigger_ritual` once every 7 days (the first call can be immediate). If this epoch's organic burn **rate** beat the previous epoch's, 10% of the treasury is burned. Epochs shorter than 7 days are scored as 7 days, so an early first ritual cannot freeze an unbeatable rate. Waiting longer than 7 days still lowers the caller's rate. Ritual burns don't count toward the next target. `get_ritual_status` returns `rate_ahead`, `additional_burn_needed`, and `treasury_burn_if_called_now`. |

## Standards

- **NEP-141** fungible token core, including `ft_transfer_call` / `ft_resolve_transfer`
- **NEP-145** storage management (fixed 0.01 NEAR per account, covers worst-case balance + stake + report records)
- **NEP-148** metadata (18 decimals, on-chain SVG icon)
- **NEP-297** events (`ft_mint`, `ft_transfer`, `ft_burn` + custom `grind` events: `stake`, `unstake`, `report`, `slash`, `ritual`)

Accounting invariant: staked tokens and treasury live in the contract account's
own balance, so `ft_total_supply == Σ ft_balance_of` always holds, and
`total_supply + burned == initial_supply`.

## Supply

- Initial supply: **1,000,000,000 GRIND** (18 decimals), minted to `owner_id` at init
- No mint function after init — supply only goes down

## Build & test

```bash
npm install
npm test          # unit tests (mocked runtime), 54 cases incl. regression + fuzz
npm run build     # -> build/contract.wasm
```

Built with [`near-sdk-js`](https://github.com/near/near-sdk-js) 2.0.0 (`MIT AND Apache-2.0`). The unit tests mock the runtime; `npm run build` compiles the WASM.

## Live on testnet

Contract: **`grind-token.testnet`** — [explorer](https://testnet.nearblocks.io/address/grind-token.testnet). Tx log: [`docs/TESTING.md`](docs/TESTING.md).

That account is still the **v0.2.1** WASM (`code_hash` `DXYwRKmB47KoYcfL7kYjToCVZxN8VeEkmzctD7GdoZBu`). It does not include the 7-day rate floor in the ritual mechanic above. Its first ritual closed a 129-second epoch that burned 5 GRIND, so the next call burns treasury only if this epoch burns more than 23,503.19 GRIND (about 4.70 million GRIND transferred). One full-access key is still on the account. Redeploy v0.2.2, then remove that key, to pick up the fix.

**Ritual #2 is open to anyone, judges included.** It unlocks 7 days after ritual #1 ([`5gm3JtsR…`](https://testnet.nearblocks.io/txns/5gm3JtsRsq2sag8kMHagaDDT5xjxzgwByZy1HEVmibZw), 8 Nov 2026), i.e. around 15 Nov 2026 UTC. Check `get_ritual_status` first: `next_ritual_in` shows the time left, `additional_burn_needed` shows how much more organic burn this epoch needs, and `treasury_burn_if_called_now` shows what calling `trigger_ritual` would burn.

## Deploy (testnet)

Use a **fresh** account. Deploy and init in a single transaction so nobody can
front-run `init`.

```bash
export CONTRACT=grind.YOUR_ACCOUNT.testnet
export OWNER=YOUR_ACCOUNT.testnet

# sub-account must be created (and funded) by its parent account;
# near-sdk-js contracts are a few hundred KB, so leave enough NEAR for code storage
near create-account $CONTRACT --useAccount $OWNER --initialBalance 10
near deploy $CONTRACT build/contract.wasm \
  --initFunction init --initArgs "{\"owner_id\":\"$OWNER\"}"
```

Optional but recommended once you're done testing: remove the contract
account's full-access keys so the code can't be swapped later.

## Usage

```bash
# Register an account (NEP-145) — required before receiving GRIND
near call $CONTRACT storage_deposit '{}' --accountId alice.testnet --deposit 0.01

# Transfer 1,000 GRIND (amounts are in raw units, 18 decimals)
near call $CONTRACT ft_transfer \
  '{"receiver_id":"alice.testnet","amount":"1000000000000000000000"}' \
  --accountId $OWNER --depositYocto 1

# Stake 100 GRIND as an agent
near call $CONTRACT stake_agent '{"amount":"100000000000000000000"}' --accountId alice.testnet

# Unstake (exactly 1 yoctoNEAR)
near call $CONTRACT unstake_agent '{"amount":"100000000000000000000"}' \
  --accountId alice.testnet --depositYocto 1

# Report an agent (3 distinct reporters within 3 days => slash)
near call $CONTRACT report_agent \
  '{"agent_id":"bob.testnet","evidence":"wash trading, tx: ..."}' --accountId alice.testnet

# Weekly ritual (anyone)
near call $CONTRACT trigger_ritual '{}' --accountId alice.testnet

# Views
near view $CONTRACT get_burn_stats
near view $CONTRACT get_ritual_status
near view $CONTRACT get_agent_info '{"agent_id":"alice.testnet"}'
near view $CONTRACT get_config
```

For `ft_transfer_call`, attach 300 TGas (`--gas 300000000000000`). All gas left after the transfer (minus the resolve callback) is forwarded to the receiver's `ft_on_transfer`.

The shell blocks above are the legacy `near-cli` short form (`--accountId`, `--depositYocto`, `--initFunction`). [`near-cli-rs`](https://docs.near.org/tools/cli) uses subcommands:

```bash
near contract call-function as-transaction $CONTRACT ft_transfer \
  json-args '{"receiver_id":"alice.testnet","amount":"1000000000000000000000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as $OWNER network-config testnet sign-with-keychain send

near contract call-function as-read-only $CONTRACT get_ritual_status \
  json-args '{}' network-config testnet now

near contract deploy $CONTRACT use-file build/contract.wasm without-init-call \
  network-config testnet sign-with-keychain send
```

Deploy and init still belong in one transaction so nobody can front-run `init`. The legacy `near deploy --initFunction` command above does that. On near-cli-rs, use `with-init-call` instead of `without-init-call` when `near contract deploy --help` lists it.

## Contract methods

| Method | Type | Notes |
|---|---|---|
| `init({owner_id})` | init | one-time, enforced by SDK |
| `ft_transfer`, `ft_transfer_call` | call | 1 yoctoNEAR |
| `ft_total_supply`, `ft_balance_of`, `ft_metadata` | view | |
| `storage_deposit`, `storage_withdraw`, `storage_unregister` | call | NEP-145 |
| `storage_balance_of`, `storage_balance_bounds` | view | NEP-145 |
| `stake_agent({amount})` | call | |
| `unstake_agent({amount})` | call | 1 yoctoNEAR |
| `report_agent({agent_id, evidence})` | call | evidence ≤ 280 chars |
| `trigger_ritual()` | call | anyone, every 7 days |
| `get_agent_info`, `get_pending_reports`, `get_agent_count` | view | |
| `get_burn_stats`, `get_ritual_status`, `get_treasury_balance`, `get_config` | view | |

## Known limitations

This is hackathon code and has **not been professionally audited**.

- Slashing is social: evidence is logged, not verified on-chain. Three colluding
  agents (or one person with three staked accounts) can slash an honest agent.
  The 1-day stake age, 7-day cooldown and 10% cap limit the damage per week,
  but don't remove the Sybil risk. A future version could weight reports by
  stake or require a reporter bond that is lost on false reports.
- The treasury only feeds the ritual burn; there's no on-chain buyback against
  a DEX pool yet.
- Staking gives reputation only — no yield. After a slash the remaining stake may be under 100 GRIND. The account is still an agent and can still be slashed; it cannot report until it stakes at least 100 again.
- Filing a report does not lock the reporter's stake. They can unstake afterward and the vote still counts. The 1-day stake age is the cost of a vote, not a bond.
- Unit tests run against a mocked runtime; see [docs/TESTING.md](docs/TESTING.md)
  for the on-chain test checklist.

## Attribution

Built during NEAR Hackathon (Nov 2026). AI-assisted: Claude reviewed and patched v0.2 → v0.2.1, and Cursor Agent wrote the v0.2.2 fixes. The only library is near-sdk-js 2.0.0, named above.

## License

MIT
