// $GRIND — Agent Utility Memecoin
// NEAR Hackathon — Track: Memecoins With Mechanics
//
// Mekanik:
//   1. Burn 0.5% di setiap transfer (total supply beneran turun)
//   2. Agent staking -> reputasi
//   3. Slash berbasis quorum (3 agent berbeda harus lapor dalam 3 hari)
//      -> 50% dibakar, 50% masuk treasury
//   4. Ritual mingguan: kalau burn organik minggu ini > minggu lalu,
//      10% treasury dibakar ("treasury burn")
//
// Standar: NEP-141 (FT core + ft_transfer_call), NEP-145 (storage),
//          NEP-148 (metadata), NEP-297 (events)
//
// Akuntansi: token yang di-stake + treasury dipegang di balance akun
// kontrak itu sendiri, jadi invarian NEP-141 tetap berlaku:
//   ft_total_supply == jumlah semua ft_balance_of

import { NearBindgen, near, call, view, initialize, assert, NearPromise } from 'near-sdk-js';

// ─── Konstanta ────────────────────────────────────────────────────

const DECIMALS        = 18;
const ONE             = 10n ** 18n;
const INITIAL_SUPPLY  = 1_000_000_000n * ONE;     // 1B GRIND
const MAX_U128        = (1n << 128n) - 1n;

const BURN_BP         = 50n;                       // 0.5% (basis point / 10_000)
const BP_DENOM        = 10_000n;

const MIN_STAKE       = 100n * ONE;                // 100 GRIND
const SLASH_PCT       = 10n;                       // 10% dari stake
const SLASH_QUORUM    = 3;                         // jumlah reporter berbeda
const RITUAL_BURN_PCT = 10n;                       // 10% treasury

const DAY_NS          = 86_400_000_000_000n;
const RITUAL_NS       = 7n * DAY_NS;
const REPORT_WINDOW   = 3n * DAY_NS;               // laporan kadaluarsa
const SLASH_COOLDOWN  = 7n * DAY_NS;               // target nggak bisa di-slash lagi
const REPORTER_MIN_AGE = 1n * DAY_NS;              // stake reporter min. 1 hari
const UNSTAKE_GRACE   = 1n * DAY_NS;               // jeda setelah laporan kadaluarsa: target bebas unstake
const MAX_EVIDENCE    = 280;
const MAX_MEMO        = 256;

// NEP-145: deposit tetap, cukup buat balance + stake record + report record.
// Worst case (account ID 64 char): bal ~147 B + stk ~235 B + rpt ~354 B = ~736 B.
// Harga storage NEAR = 10^19 yocto per byte. Dibulatkan ke 1000 B = 0.01 NEAR.
const BYTE_COST       = 10n ** 19n;
const STORAGE_BYTES   = 1_000n;
const STORAGE_MIN     = STORAGE_BYTES * BYTE_COST;  // 0.01 NEAR = 10^22 yocto

const ONE_YOCTO       = 1n;
const TGAS            = 1_000_000_000_000n;
const GAS_ON_TRANSFER = 50n * TGAS;
const GAS_RESOLVE     = 30n * TGAS;
const GAS_MIN_FT_CALL = 120n * TGAS;
const GAS_RESERVE     = 10n * TGAS;                // sisa buat nyelesaiin ft_transfer_call

const ICON = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Ccircle cx=%2732%27 cy=%2732%27 r=%2730%27 fill=%27%23111%27/%3E%3Cpath d=%27M32 12c6 10 12 14 12 24a12 12 0 0 1-24 0c0-6 4-9 6-14 2 5 6 6 6 10 0-8-2-13 0-20z%27 fill=%27%23ff6a00%27/%3E%3C/svg%3E';

// ─── Helper ───────────────────────────────────────────────────────

function parseAmount(a, label = 'amount') {
  assert(typeof a === 'string' && /^[0-9]+$/.test(a), `Invalid ${label}: must be a non-negative integer string`);
  const v = BigInt(a);
  assert(v > 0n, `${label} must be > 0`);
  assert(v <= MAX_U128, `${label} overflows u128`);
  return v;
}

function validAccountId(id) {
  return typeof id === 'string'
    && id.length >= 2 && id.length <= 64
    && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

function assertAccountId(id, label) {
  assert(validAccountId(id), `Invalid ${label}`);
}

function assertOneYocto() {
  assert(near.attachedDeposit() === ONE_YOCTO, 'Requires attached deposit of exactly 1 yoctoNEAR');
}

function emit(standard, version, event, data) {
  near.log(`EVENT_JSON:${JSON.stringify({ standard, version, event, data })}`);
}

// Raw storage. Account ID NEAR nggak boleh mengandung ':' jadi key aman.
const K = {
  bal: (a) => `bal:${a}`,
  stk: (a) => `stk:${a}`,
  rpt: (a) => `rpt:${a}`,
};

function read(key)        { return near.storageRead(key); }
function write(key, val)  { near.storageWrite(key, val); }
function remove(key)      { near.storageRemove(key); }

function isRegistered(acct) { return read(K.bal(acct)) !== null; }

function balOf(acct) {
  const r = read(K.bal(acct));
  return r === null ? null : BigInt(r);
}

function setBal(acct, v) {
  assert(v >= 0n, 'Negative balance');
  write(K.bal(acct), v.toString());
}

function getStake(acct) {
  const r = read(K.stk(acct));
  return r === null ? null : JSON.parse(r);
}

function reputationOf(amount, slashCount) {
  const base = amount / MIN_STAKE;
  const penalty = BigInt(slashCount);
  return base > penalty ? base - penalty : 0n;
}

function stakeView(s) {
  return {
    amount: s.amount,
    reputation: reputationOf(BigInt(s.amount), s.slash_count).toString(),
    joined_at: s.joined_at,
    last_slash: s.last_slash,
    slash_count: s.slash_count,
  };
}

// ─── Kontrak ──────────────────────────────────────────────────────

@NearBindgen({ requireInit: true })
class GrindToken {
  constructor() {
    this.owner_id       = '';
    this.totalSupply    = 0n;
    this.totalBurned    = 0n;
    this.treasury       = 0n;   // bagian dari balance akun kontrak
    this.totalStaked    = 0n;   // bagian dari balance akun kontrak
    this.agentCount     = 0;
    this.curEpochBurn   = 0n;   // burn organik (transfer + slash) epoch ini
    this.lastEpochBurn  = 0n;
    this.lastRitual     = 0n;
    this.ritualCount    = 0;
    this.epochStart     = 0n;   // awal epoch sekarang
    this.lastEpochDur   = 0n;   // panjang epoch lalu (ns)
  }

  // ─── INIT ─────────────────────────────────────────────────────

  @initialize({})
  init({ owner_id }) {
    assertAccountId(owner_id, 'owner_id');
    const self = near.currentAccountId();
    assert(owner_id !== self, 'Owner must not be the contract account');

    this.owner_id    = owner_id;
    this.totalSupply = INITIAL_SUPPLY;
    this.epochStart  = near.blockTimestamp();

    setBal(self, 0n);              // vault untuk stake + treasury
    setBal(owner_id, INITIAL_SUPPLY);

    emit('nep141', '1.0.0', 'ft_mint', [{
      owner_id, amount: INITIAL_SUPPLY.toString(), memo: 'Initial supply',
    }]);
  }

  // ─── Internal ─────────────────────────────────────────────────

  _burnFrom(acct, amount, memo) {
    if (amount <= 0n) return;
    setBal(acct, balOf(acct) - amount);
    this.totalSupply -= amount;
    this.totalBurned += amount;
    emit('nep141', '1.0.0', 'ft_burn', [{ owner_id: acct, amount: amount.toString(), memo }]);
  }

  // Transfer dengan burn 0.5%. Return jumlah bersih yang diterima.
  _transfer(sender, receiver, amount, memo) {
    const self = near.currentAccountId();
    assertAccountId(receiver, 'receiver_id');
    assert(sender !== receiver, 'Sender and receiver must differ');
    assert(sender !== self && receiver !== self, 'Contract vault cannot send or receive transfers');
    assert(memo === undefined || memo === null || (typeof memo === 'string' && memo.length <= MAX_MEMO), 'Memo too long');

    const sBal = balOf(sender);
    assert(sBal !== null, `Account ${sender} is not registered`);
    assert(isRegistered(receiver), `Account ${receiver} is not registered`);
    assert(sBal >= amount, 'Insufficient balance');

    const burn = amount * BURN_BP / BP_DENOM;
    const net  = amount - burn;

    setBal(sender, sBal - amount);
    setBal(receiver, balOf(receiver) + net);
    emit('nep141', '1.0.0', 'ft_transfer', [{
      old_owner_id: sender, new_owner_id: receiver, amount: net.toString(),
      ...(memo ? { memo } : {}),
    }]);

    if (burn > 0n) {
      // token yang dibakar keluar dari supply tanpa pernah masuk ke receiver
      this.totalSupply  -= burn;
      this.totalBurned  += burn;
      this.curEpochBurn += burn;
      emit('nep141', '1.0.0', 'ft_burn', [{ owner_id: sender, amount: burn.toString(), memo: 'transfer burn 0.5%' }]);
    }
    return net;
  }

  // ─── NEP-141 ──────────────────────────────────────────────────

  @view({})
  ft_total_supply() { return this.totalSupply.toString(); }

  @view({})
  ft_balance_of({ account_id }) {
    const b = balOf(account_id);
    return b === null ? '0' : b.toString();
  }

  @call({ payableFunction: true })
  ft_transfer({ receiver_id, amount, memo }) {
    assertOneYocto();
    const amt = parseAmount(amount);
    this._transfer(near.predecessorAccountId(), receiver_id, amt, memo);
  }

  @call({ payableFunction: true })
  ft_transfer_call({ receiver_id, amount, memo, msg }) {
    assertOneYocto();
    assert(typeof msg === 'string', 'msg is required');
    assert(near.prepaidGas() >= GAS_MIN_FT_CALL, 'More gas is required (use 300 TGas)');
    const sender = near.predecessorAccountId();
    const amt = parseAmount(amount);
    const net = this._transfer(sender, receiver_id, amt, memo);

    // teruskan semua sisa gas ke receiver (DEX multi-hop bisa butuh > 50 TGas)
    const gasLeft = near.prepaidGas() - near.usedGas() - GAS_RESOLVE - GAS_RESERVE;
    assert(gasLeft >= GAS_ON_TRANSFER, 'More gas is required (use 300 TGas)');

    return NearPromise.new(receiver_id)
      .functionCall('ft_on_transfer',
        JSON.stringify({ sender_id: sender, amount: net.toString(), msg }),
        0n, gasLeft)
      .then(
        NearPromise.new(near.currentAccountId())
          .functionCall('ft_resolve_transfer',
            JSON.stringify({ sender_id: sender, receiver_id, amount: net.toString() }),
            0n, GAS_RESOLVE)
      );
  }

  @call({ privateFunction: true })
  ft_resolve_transfer({ sender_id, receiver_id, amount }) {
    const amt = BigInt(amount);
    let unused = amt;
    try {
      const raw = near.promiseResult(0);
      const parsed = JSON.parse(raw);
      const v = BigInt(parsed);
      unused = v < 0n ? 0n : (v > amt ? amt : v);
    } catch (_) {
      unused = amt; // receiver gagal -> refund semua
    }

    if (unused > 0n) {
      const rBal = balOf(receiver_id) ?? 0n;
      const refund = unused < rBal ? unused : rBal;
      if (refund > 0n) {
        setBal(receiver_id, rBal - refund);
        if (isRegistered(sender_id)) {
          setBal(sender_id, balOf(sender_id) + refund);
          emit('nep141', '1.0.0', 'ft_transfer', [{
            old_owner_id: receiver_id, new_owner_id: sender_id,
            amount: refund.toString(), memo: 'refund',
          }]);
        } else {
          // sender sudah unregister -> bakar aja
          this.totalSupply -= refund;
          this.totalBurned += refund;
          emit('nep141', '1.0.0', 'ft_burn', [{ owner_id: receiver_id, amount: refund.toString(), memo: 'refund to unregistered sender' }]);
        }
        return (amt - refund).toString();
      }
    }
    return amt.toString();
  }

  // ─── NEP-148 ──────────────────────────────────────────────────

  @view({})
  ft_metadata() {
    return {
      spec: 'ft-1.0.0',
      name: 'Grind',
      symbol: 'GRIND',
      icon: ICON,
      reference: null,
      reference_hash: null,
      decimals: DECIMALS,
    };
  }

  // ─── NEP-145 ──────────────────────────────────────────────────

  @call({ payableFunction: true })
  storage_deposit({ account_id, registration_only } = {}) {
    const caller  = near.predecessorAccountId();
    const acct    = account_id ?? caller;
    const deposit = near.attachedDeposit();
    assertAccountId(acct, 'account_id');

    let refund;
    if (isRegistered(acct)) {
      refund = deposit;
    } else {
      assert(deposit >= STORAGE_MIN, `Attach at least ${STORAGE_MIN} yoctoNEAR`);
      setBal(acct, 0n);
      refund = deposit - STORAGE_MIN;
    }
    if (refund > 0n) {
      const p = near.promiseBatchCreate(caller);
      near.promiseBatchActionTransfer(p, refund);
    }
    return { total: STORAGE_MIN.toString(), available: '0' };
  }

  @call({ payableFunction: true })
  storage_withdraw({ amount } = {}) {
    assertOneYocto();
    const acct = near.predecessorAccountId();
    assert(isRegistered(acct), 'Account not registered');
    assert(amount === undefined || amount === null || amount === '0', 'Nothing available to withdraw');
    return { total: STORAGE_MIN.toString(), available: '0' };
  }

  @call({ payableFunction: true })
  storage_unregister({ force } = {}) {
    assertOneYocto();
    const acct = near.predecessorAccountId();
    if (!isRegistered(acct)) return false;
    assert(acct !== near.currentAccountId(), 'Vault cannot unregister');
    assert(getStake(acct) === null, 'Unstake first');
    const b = balOf(acct);
    if (b > 0n) {
      assert(force === true, 'Balance is not empty, pass force=true to burn it');
      this._burnFrom(acct, b, 'storage_unregister force');
    }
    remove(K.bal(acct));
    remove(K.rpt(acct));
    const p = near.promiseBatchCreate(acct);
    near.promiseBatchActionTransfer(p, STORAGE_MIN);
    return true;
  }

  @view({})
  storage_balance_of({ account_id }) {
    return isRegistered(account_id) ? { total: STORAGE_MIN.toString(), available: '0' } : null;
  }

  @view({})
  storage_balance_bounds() {
    return { min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() };
  }

  // ─── STAKING ──────────────────────────────────────────────────

  @call({})
  stake_agent({ amount }) {
    const agent = near.predecessorAccountId();
    const self  = near.currentAccountId();
    assert(agent !== self, 'Vault cannot stake');
    const amt = parseAmount(amount);

    const b = balOf(agent);
    assert(b !== null, 'Account not registered');
    assert(b >= amt, 'Not enough $GRIND');

    let s = getStake(agent);
    if (s === null) {
      assert(amt >= MIN_STAKE, 'Min 100 $GRIND to stake');
      s = { amount: '0', joined_at: near.blockTimestamp().toString(), last_slash: '0', slash_count: 0 };
      this.agentCount += 1;
    }
    s.amount = (BigInt(s.amount) + amt).toString();

    setBal(agent, b - amt);
    setBal(self, balOf(self) + amt);
    this.totalStaked += amt;
    write(K.stk(agent), JSON.stringify(s));

    emit('grind', '1.0.0', 'stake', [{ agent_id: agent, amount: amt.toString(), total: s.amount }]);
  }

  @call({})
  unstake_agent({ amount }) {
    const agent = near.predecessorAccountId();
    const self  = near.currentAccountId();
    const amt   = parseAmount(amount);

    const s = getStake(agent);
    assert(s !== null, 'No active stake');
    const cur = BigInt(s.amount);
    assert(cur >= amt, 'Not enough staked');

    // anti kabur: nggak bisa unstake kalau lagi ada laporan aktif
    const r = read(K.rpt(agent));
    if (r !== null) {
      const rep = JSON.parse(r);
      assert(near.blockTimestamp() - BigInt(rep.since) >= REPORT_WINDOW,
        'Pending reports against you; wait until the report window expires');
      remove(K.rpt(agent));
    }

    const left = cur - amt;
    assert(left === 0n || left >= MIN_STAKE, 'Remaining stake must be 0 or >= 100 $GRIND');

    if (left === 0n) {
      remove(K.stk(agent));
      this.agentCount -= 1;
    } else {
      s.amount = left.toString();
      write(K.stk(agent), JSON.stringify(s));
    }

    this.totalStaked -= amt;
    setBal(self, balOf(self) - amt);
    setBal(agent, balOf(agent) + amt);

    emit('grind', '1.0.0', 'unstake', [{ agent_id: agent, amount: amt.toString(), total: left.toString() }]);
  }

  // Slash butuh SLASH_QUORUM reporter berbeda dalam REPORT_WINDOW.
  // Laporan ke-N (N = quorum) yang mengeksekusi slash.
  @call({})
  report_agent({ agent_id, evidence }) {
    const reporter = near.predecessorAccountId();
    const now = near.blockTimestamp();
    assert(typeof evidence === 'string' && evidence.trim().length > 0, 'Evidence required');
    assert(evidence.length <= MAX_EVIDENCE, `Evidence max ${MAX_EVIDENCE} chars`);
    assert(reporter !== agent_id, 'Cannot report yourself');

    const rs = getStake(reporter);
    assert(rs !== null && BigInt(rs.amount) >= MIN_STAKE, 'Only agents with >= 100 $GRIND staked can report');
    assert(now - BigInt(rs.joined_at) >= REPORTER_MIN_AGE, 'Reporter stake must be at least 1 day old');

    const ts = getStake(agent_id);
    assert(ts !== null, 'Target has no stake');
    assert(BigInt(ts.last_slash) === 0n || now - BigInt(ts.last_slash) >= SLASH_COOLDOWN,
      'Target was slashed recently (7-day cooldown)');

    let rep = null;
    const raw = read(K.rpt(agent_id));
    if (raw !== null) {
      rep = JSON.parse(raw);
      const age = now - BigInt(rep.since);
      if (age >= REPORT_WINDOW) {
        // kadaluarsa tanpa quorum -> kasih target jeda buat unstake, biar 1 griefer
        // nggak bisa ngunci stake selamanya dengan lapor ulang tiap 3 hari
        assert(age >= REPORT_WINDOW + UNSTAKE_GRACE,
          'Previous report round expired; target is in a 1-day grace period');
        rep = null;
      }
    }
    if (rep === null) rep = { since: now.toString(), reporters: [] };
    assert(!rep.reporters.includes(reporter), 'You already reported this agent');
    rep.reporters.push(reporter);

    emit('grind', '1.0.0', 'report', [{
      agent_id, reporter_id: reporter, evidence,
      reports: rep.reporters.length, quorum: SLASH_QUORUM,
    }]);

    if (rep.reporters.length < SLASH_QUORUM) {
      write(K.rpt(agent_id), JSON.stringify(rep));
      return { slashed: false, reports: rep.reporters.length, quorum: SLASH_QUORUM };
    }

    // ── quorum tercapai: eksekusi slash ──
    remove(K.rpt(agent_id));
    const self   = near.currentAccountId();
    const staked = BigInt(ts.amount);
    const slash  = staked * SLASH_PCT / 100n;
    const burn   = slash / 2n;
    const toTreasury = slash - burn;

    ts.amount      = (staked - slash).toString();
    ts.last_slash  = now.toString();
    ts.slash_count = (ts.slash_count || 0) + 1;
    write(K.stk(agent_id), JSON.stringify(ts));

    this.totalStaked -= slash;
    this.treasury    += toTreasury;           // tetap di balance vault
    this._burnFrom(self, burn, `slash ${agent_id}`);
    this.curEpochBurn += burn;

    emit('grind', '1.0.0', 'slash', [{
      agent_id, amount: slash.toString(), burned: burn.toString(),
      treasury: toTreasury.toString(), reporters: rep.reporters,
    }]);
    return { slashed: true, amount: slash.toString(), reports: rep.reporters.length, quorum: SLASH_QUORUM };
  }

  // ─── RITUAL MINGGUAN ──────────────────────────────────────────

  @call({})
  trigger_ritual() {
    const now = near.blockTimestamp();
    assert(this.lastRitual === 0n || now - this.lastRitual >= RITUAL_NS, 'Ritual once per 7 days');

    // Bandingkan LAJU burn (burn / durasi), bukan total, supaya pemanggil nggak
    // bisa "menang" cuma dengan nunda ritual biar epoch-nya lebih panjang.
    //   cur / curDur > last / lastDur  <=>  cur * lastDur > last * curDur
    const curDur = now - this.epochStart > 0n ? now - this.epochStart : 1n;
    const burnUp = this.lastRitual > 0n
      ? this.curEpochBurn * this.lastEpochDur > this.lastEpochBurn * curDur
      : this.curEpochBurn > 0n;

    let ritualBurn = 0n;
    if (burnUp && this.treasury > 0n) {
      ritualBurn = this.treasury * RITUAL_BURN_PCT / 100n;
      if (ritualBurn > 0n) {
        this.treasury -= ritualBurn;
        this._burnFrom(near.currentAccountId(), ritualBurn, 'weekly ritual treasury burn');
        // sengaja TIDAK ditambah ke curEpochBurn biar target minggu depan nggak ikut naik
      }
    }

    emit('grind', '1.0.0', 'ritual', [{
      ritual: this.ritualCount + 1,
      epoch_burn: this.curEpochBurn.toString(),
      previous_epoch_burn: this.lastEpochBurn.toString(),
      epoch_duration_ns: curDur.toString(),
      previous_epoch_duration_ns: this.lastEpochDur.toString(),
      treasury_burned: ritualBurn.toString(),
    }]);

    this.lastEpochBurn = this.curEpochBurn;
    this.lastEpochDur  = curDur;
    this.epochStart    = now;
    this.curEpochBurn  = 0n;
    this.lastRitual    = now;
    this.ritualCount  += 1;
    return { treasury_burned: ritualBurn.toString(), ritual_count: this.ritualCount };
  }

  // ─── VIEWS ────────────────────────────────────────────────────

  @view({})
  get_agent_info({ agent_id }) {
    const s = getStake(agent_id);
    return s === null ? null : stakeView(s);
  }

  @view({})
  get_pending_reports({ agent_id }) {
    const r = read(K.rpt(agent_id));
    return r === null ? null : JSON.parse(r);
  }

  @view({})
  get_treasury_balance() { return this.treasury.toString(); }

  @view({})
  get_agent_count() { return this.agentCount; }

  @view({})
  get_ritual_status() {
    const now = near.blockTimestamp();
    const elapsed = now - this.lastRitual;
    return {
      last_ritual_time: this.lastRitual.toString(),
      ritual_count: this.ritualCount,
      next_ritual_in: this.lastRitual === 0n || elapsed >= RITUAL_NS ? '0' : (RITUAL_NS - elapsed).toString(),
      last_epoch_burn: this.lastEpochBurn.toString(),
      last_epoch_duration_ns: this.lastEpochDur.toString(),
      current_epoch_burn: this.curEpochBurn.toString(),
      current_epoch_started: this.epochStart.toString(),
    };
  }

  @view({})
  get_burn_stats() {
    return {
      initial_supply: INITIAL_SUPPLY.toString(),
      total_supply: this.totalSupply.toString(),
      burned: this.totalBurned.toString(),
      treasury: this.treasury.toString(),
      staked: this.totalStaked.toString(),
      circulating: (this.totalSupply - this.treasury - this.totalStaked).toString(),
    };
  }

  @view({})
  get_config() {
    return {
      owner_id: this.owner_id,
      burn_bp: BURN_BP.toString(),
      min_stake: MIN_STAKE.toString(),
      slash_pct: SLASH_PCT.toString(),
      slash_quorum: SLASH_QUORUM,
      report_window_ns: REPORT_WINDOW.toString(),
      slash_cooldown_ns: SLASH_COOLDOWN.toString(),
      unstake_grace_ns: UNSTAKE_GRACE.toString(),
      ritual_interval_ns: RITUAL_NS.toString(),
      ritual_burn_pct: RITUAL_BURN_PCT.toString(),
      storage_min: STORAGE_MIN.toString(),
    };
  }
}
