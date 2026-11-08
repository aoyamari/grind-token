# Testing

> Hackathon self-testing notes. This is **not** a third-party security audit.

## 1. Unit tests (mocked runtime)

```bash
npm test
```

`test/contract.test.cjs` loads `src/contract.js`, strips decorators, and mocks
the `near` API (storage, predecessor, deposit, gas, block time, promises, logs).
It tests contract **logic**, not the compiled WASM.

49 cases covering:

- init, metadata shape (object, 18 decimals)
- NEP-145 registration, refunds, unregister with/without `force`, deposit covers worst-case storage
- `ft_transfer`: 1 yocto requirement, registration, account-ID validation,
  amount validation (negative / decimal / zero / non-string / > u128),
  self-transfer, vault protection, 0.5% burn reducing total supply
- `ft_transfer_call` / `ft_resolve_transfer`: net amount forwarded, partial
  refund, full refund on failure, capping a bogus `unused` value, remaining gas forwarded
- staking: min stake, top-up, partial/full unstake, storage actually removed
- slashing: quorum of 3, no duplicate reporters, 3-day report expiry, 7-day
  cooldown, reporter age, self-report, evidence limits, no unstake while reported,
  1-day grace period after an expired report round
- ritual: 7-day cooldown, treasury burn only when the organic burn *rate* grows,
  epoch durations recorded, ritual burn excluded from next epoch's target
- **invariants** after every step of a 200-operation random run:
  `Σ balances == total_supply`, `vault == staked + treasury`,
  `total_supply + burned == initial_supply`

### Regression tests for bugs found in v0.1

| Bug in v0.1 | Test |
|---|---|
| `unstake_agent` accepted negative amounts → free stake & reputation, negative balances | `REGRESI: unstake amount negatif ditolak` |
| One staked account could slash any agent repeatedly | `REGRESI: satu reporter nggak bisa spam slash` |
| `init` was a public call (front-runnable) | now `@initialize` + `requireInit` |
| `decimals: 18` but supply was 1e9 raw units | `init mint 1B * 10^18` |
| `ft_total_supply` never decreased after burns | `burn 0.5%: total supply beneran turun` + invariants |
| Views returned JSON strings | `ft_metadata return object` |
| `ft_transfer` didn't require 1 yocto | `wajib 1 yoctoNEAR` |
| Anyone could create storage for any account ID | `receiver belum register ditolak` |
| Deleted keys were written as `''` instead of removed | `unstake parsial & penuh` |

### Regression tests for bugs found in v0.2

| Bug in v0.2 | Test |
|---|---|
| `STORAGE_MIN` was `5e18` yocto (0.000005 NEAR, a missing `000`) instead of 0.005 NEAR — the contract paid ~0.0015–0.007 NEAR of its own balance for every registration, so mass registrations could drain it | `REGRESI: STORAGE_MIN = 0.01 NEAR …` |
| A single staked griefer could lock a target's stake forever by re-reporting the moment each 3-day window expired | `REGRESI: 1 griefer nggak bisa ngunci unstake selamanya` |
| Ritual compared total burn of epochs with different lengths, so whoever called it could just wait until the target was beaten | `laju burn turun -> treasury nggak dibakar …` |
| `ft_transfer_call` forwarded a fixed 50 TGas to the receiver, too little for some DEX flows | `sisa gas diteruskan ke ft_on_transfer` |

## 2. On-chain checklist (testnet)

Deployed: **`grind-token.testnet`** — [explorer](https://testnet.nearblocks.io/address/grind-token.testnet), owner `callmeaoyama.testnet`.
Rows without a link are still pending (slashing needs 3 reporters with stakes older than 1 day).

Deploy to a **fresh** account (see README), then record each tx hash with an
explorer link in the table below.

| # | Scenario | Expected | Tx / explorer link |
|---|---|---|---|
| 1 | deploy + init in one tx | `ft_mint` event, owner has 1e27 raw | [`hhQMKygy…`](https://testnet.nearblocks.io/txns/hhQMKygywNZTgoHYYD9Ftn5C2TVADamKT9EaLSX138B) ✅ |
| 2 | `storage_deposit` (0.01 NEAR) for 4 test accounts | registered; check contract `storage_usage` delta ≤ 1000 bytes per account | [`CvADz4wM…`](https://testnet.nearblocks.io/txns/CvADz4wM5xHzvMuZNQPHhVxT3rYfHUmzFUpGcPBBf2kK) ✅ + [`CrVEVYri…`](https://testnet.nearblocks.io/txns/CrVEVYrijAeuYPksHjzv7z7sUe2KkJ3s4gHxoV15ST4q), [`AKx6PXTH…`](https://testnet.nearblocks.io/txns/AKx6PXTHw9PLNRfz3hbfUAoc2aFF4oucevefPQVqSkwb), [`BcWdoNtw…`](https://testnet.nearblocks.io/txns/BcWdoNtwMVjxNA5wR6dXMvsmz8dT7ZwtwT9ybxFGEVSe), [`Eoiwvt3t…`](https://testnet.nearblocks.io/txns/Eoiwvt3teih5FLTaaBuBqV9vByN8Zi1SrVeGspbcapFk) (5 accounts) |
| 3 | `ft_transfer` 1000 GRIND | receiver +995, supply −5, `ft_burn` event | [`ETaNLgmp…`](https://testnet.nearblocks.io/txns/ETaNLgmpfnC7TqzFtQihtCbiL9GUFmQp87moJhTczooC) ✅ receiver got 995, supply −5 |
| 4 | `ft_transfer` with 0 deposit | panic: 1 yoctoNEAR | ✅ panicked: `Requires attached deposit of exactly 1 yoctoNEAR` |
| 5 | `ft_transfer` to unregistered | panic: not registered | ✅ panicked: `not registered` |
| 6 | `stake_agent` 3 reporters + 1 target | `stake` events | [`Dou9eSmE…`](https://testnet.nearblocks.io/txns/Dou9eSmEWtJXCuNFM4RtK1kZN8BBTyuNrV8dYXFAnmQo) ✅ target `grindtopup` + reporters [`Dpt21aLK…`](https://testnet.nearblocks.io/txns/Dpt21aLKQtpsadSHsTMXfUMFoj9gbzfKZRxXsaL6uNvM), [`b7Udu2dw…`](https://testnet.nearblocks.io/txns/b7Udu2dwhxVZq3VcAKoDPfEcY9jXAdrMcp5D8tKLC22), [`A23EiUxE…`](https://testnet.nearblocks.io/txns/A23EiUxEK8p2sKzzWYQZp8cVZVXwu2Wj43wtuQqb9GPG) |
| 7 | `unstake_agent` with `"-1"` | panic: Invalid amount | ✅ panicked: `Invalid amount: must be a non-negative integer string` |
| 8 | 3× `report_agent` after 1 day | 3rd tx emits `slash` | |
| 9 | 4th report same week | panic: cooldown | |
| 10 | `trigger_ritual` | `ritual` event, treasury burn if applicable | [`5gm3JtsR…`](https://testnet.nearblocks.io/txns/5gm3JtsRsq2sag8kMHagaDDT5xjxzgwByZy1HEVmibZw) ✅ ritual #1 (first ritual, treasury empty → 0 burned) |
| 11 | `ft_transfer_call` to a contract implementing `ft_on_transfer` | refund path works | ✅ receiver `grind-receiver.testnet` ([source](../test/ft-receiver.js)), 100 GRIND each: keep [`5gvpTmYr…`](https://testnet.nearblocks.io/txns/5gvpTmYrjf36qUgsdcLx9UdVSn8tjWQwan5pe2RRfujn) (unused 0), half [`ETVy5xhv…`](https://testnet.nearblocks.io/txns/ETVy5xhvCmRuJGstVuSmfZChG6Hoq4CELDfDRw34yKjX) (49.75 refunded), refund [`GB1JcQmB…`](https://testnet.nearblocks.io/txns/GB1JcQmBzSkCFZ7gyaEU4VkGtYZZWMJms5nsBjAfm2pU) (99.5 refunded), receiver panic [`BVJ4eLkK…`](https://testnet.nearblocks.io/txns/BVJ4eLkKyAty6Svprp9C3f7EdbjtsVsSigCcqjBVSef4) (99.5 refunded). 0.5% burn is kept on refunds. 100 TGas → `More gas is required` |
