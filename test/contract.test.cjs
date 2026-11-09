#!/usr/bin/env node
// $GRIND — unit test suite (mock runtime, tanpa testnet)
// Jalankan: npm test
//
// Kontrak di-load dari ../src/contract.js, decorator & import di-strip,
// lalu API `near` di-mock. Ini nguji LOGIKA, bukan WASM hasil build —
// tetap lakukan uji on-chain di testnet (lihat docs/TESTING.md).

const { strict: A } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ── Mock runtime ─────────────────────────────────────────────────
const SELF = 'grind.testnet';
const ONE = 10n ** 18n;
const G = (n) => (BigInt(n) * ONE).toString();     // n GRIND -> string raw
const DAY = 86_400_000_000_000n;
const STORAGE_MIN = 10n ** 22n;                      // 0.01 NEAR

let storage, logs, transfers, ctx;

function reset() {
  storage = new Map(); logs = []; transfers = [];
  ctx = { predecessor: 'owner.testnet', deposit: 0n, ts: 1_000_000n, gas: 300n * 10n ** 12n, promiseResult: null };
}

globalThis.near = {
  storageRead: (k) => (storage.has(k) ? storage.get(k) : null),
  storageWrite: (k, v) => { storage.set(k, String(v)); },
  storageRemove: (k) => storage.delete(k),
  predecessorAccountId: () => ctx.predecessor,
  currentAccountId: () => SELF,
  attachedDeposit: () => ctx.deposit,
  blockTimestamp: () => ctx.ts,
  prepaidGas: () => ctx.gas,
  usedGas: () => 5n * 10n ** 12n,
  log: (m) => logs.push(m),
  promiseBatchCreate: (acct) => { transfers.push({ to: acct, amount: 0n }); return transfers.length - 1; },
  promiseBatchActionTransfer: (i, amt) => { transfers[i].amount = amt; },
  promiseResult: () => {
    if (ctx.promiseResult === 'FAIL') throw new Error('Promise failed');
    return ctx.promiseResult;
  },
};
globalThis.assert = (c, m) => { if (!c) throw new Error(m); };
globalThis.NearPromise = class {
  static new(acct) { const p = new this(); p.calls = [{ acct }]; return p; }
  functionCall(name, args, amt, gas) { Object.assign(this.calls[this.calls.length - 1], { name, args: JSON.parse(args), gas }); return this; }
  then(other) { this.calls.push(...other.calls); return this; }
};

let code = fs.readFileSync(path.join(__dirname, '..', 'src', 'contract.js'), 'utf8')
  .replace(/^import .+;$/gm, '')
  .replace(/^\s*@\w+\(.*\)\s*$/gm, '')
  .replace(/^class GrindToken \{/m, 'globalThis.GrindToken = class GrindToken {');
(0, eval)(code);

// ── Helper ───────────────────────────────────────────────────────
let c;
function as(acct, deposit = 0n) { ctx.predecessor = acct; ctx.deposit = deposit; return c; }
function yocto(acct) { return as(acct, 1n); }
function register(acct) { as(acct, STORAGE_MIN).storage_deposit({}); }
function advance(days) { ctx.ts += BigInt(days) * DAY; }
function fresh() {
  reset();
  c = new GrindToken();
  as(SELF).init({ owner_id: 'owner.testnet' });
  return c;
}
function bal(a) { return BigInt(c.ft_balance_of({ account_id: a })); }
function sumBalances() {
  let s = 0n; for (const [k, v] of storage) if (k.startsWith('bal:')) s += BigInt(v); return s;
}
function invariant() {
  A.equal(sumBalances().toString(), c.ft_total_supply(), 'sum(balances) == total_supply');
  const st = c.get_burn_stats();
  A.equal(bal(SELF), BigInt(st.staked) + BigInt(st.treasury), 'vault == staked + treasury');
  A.equal(BigInt(st.total_supply) + BigInt(st.burned), BigInt(st.initial_supply), 'supply + burned == initial');
}
function events(name) {
  return logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))).filter((e) => e.event === name);
}
// siapkan N agent yang sudah stake & berumur > 1 hari
function agents(names, stakeEach = 1000) {
  for (const n of names) {
    register(n);
    yocto('owner.testnet').ft_transfer({ receiver_id: n, amount: G(stakeEach * 2) });
    as(n).stake_agent({ amount: G(stakeEach) });
  }
  advance(2);
}

let total = 0, passed = 0; const failed = [];
function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push(name); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function section(t) { console.log(`\n${t}`); }

// ═══════════════════════════ SUITE ═══════════════════════════════

section('Init & metadata');
test('init mint 1B * 10^18 ke owner + event ft_mint', () => {
  fresh();
  A.equal(c.ft_total_supply(), G(1_000_000_000));
  A.equal(bal('owner.testnet'), BigInt(G(1_000_000_000)));
  A.equal(events('ft_mint').length, 1);
  invariant();
});
test('owner == akun kontrak ditolak', () => {
  reset(); c = new GrindToken();
  A.throws(() => as(SELF).init({ owner_id: SELF }), /must not be the contract/);
});
test('get_config memuat umur minimum reporter', () => {
  fresh();
  const cfg = c.get_config();
  A.equal(cfg.reporter_min_age_ns, DAY.toString());
  A.equal(cfg.ritual_interval_ns, (7n * DAY).toString());
  A.equal(cfg.burn_bp, '50');
});
test('ft_metadata return object (bukan string) + decimals 18', () => {
  fresh();
  const m = c.ft_metadata();
  A.equal(typeof m, 'object');
  A.equal(m.decimals, 18); A.equal(m.symbol, 'GRIND'); A.equal(m.spec, 'ft-1.0.0');
  A.ok('reference' in m && 'reference_hash' in m);
});

section('NEP-145 storage');
test('REGRESI: STORAGE_MIN = 0.01 NEAR dan cukup buat worst-case storage', () => {
  fresh();
  A.equal(c.storage_balance_bounds().min, (10n ** 22n).toString(), '0.01 NEAR = 10^22 yocto');
  // worst case: account ID 64 char, semua record terisi
  const id = 'x'.repeat(64), rec = (k, v) => k.length + v.length + 40;
  const bytes = rec('bal:' + id, (1n << 128n).toString())
    + rec('stk:' + id, JSON.stringify({ amount: (10n ** 27n).toString(), joined_at: '1'.repeat(19), last_slash: '1'.repeat(19), slash_count: 999 }))
    + rec('rpt:' + id, JSON.stringify({ since: '1'.repeat(19), reporters: [id, id, id] }));
  A.ok(BigInt(bytes) * 10n ** 19n <= 10n ** 22n, `butuh ${bytes} byte`);
});
test('storage_deposit kurang dari minimum ditolak', () => {
  fresh();
  A.throws(() => as('alice.testnet', 1n).storage_deposit({}), /Attach at least/);
});
test('storage_deposit refund kelebihan', () => {
  fresh();
  as('alice.testnet', STORAGE_MIN + 100n).storage_deposit({});
  A.equal(transfers.at(-1).amount, 100n);
  A.deepEqual(c.storage_balance_of({ account_id: 'alice.testnet' }), { total: STORAGE_MIN.toString(), available: '0' });
});
test('storage_deposit ulang -> refund penuh', () => {
  fresh(); register('alice.testnet');
  as('alice.testnet', STORAGE_MIN).storage_deposit({});
  A.equal(transfers.at(-1).amount, STORAGE_MIN);
});
test('storage_unregister dengan saldo butuh force, saldo dibakar', () => {
  fresh(); register('alice.testnet');
  yocto('owner.testnet').ft_transfer({ receiver_id: 'alice.testnet', amount: G(10) });
  A.throws(() => yocto('alice.testnet').storage_unregister({}), /force=true/);
  A.equal(yocto('alice.testnet').storage_unregister({ force: true }), true);
  A.equal(c.storage_balance_of({ account_id: 'alice.testnet' }), null);
  invariant();
});

section('ft_transfer');
test('wajib 1 yoctoNEAR', () => {
  fresh(); register('alice.testnet');
  A.throws(() => as('owner.testnet', 0n).ft_transfer({ receiver_id: 'alice.testnet', amount: G(1) }), /1 yoctoNEAR/);
  A.throws(() => as('owner.testnet', 5n).ft_transfer({ receiver_id: 'alice.testnet', amount: G(1) }), /1 yoctoNEAR/);
});
test('receiver belum register ditolak (anti storage spam)', () => {
  fresh();
  A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: 'random.testnet', amount: G(1) }), /not registered/);
});
test('receiver_id invalid ditolak', () => {
  fresh();
  A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: 'BAD ID!', amount: G(1) }), /Invalid receiver_id/);
});
test('burn 0.5%: total supply beneran turun + event ft_burn', () => {
  fresh(); register('alice.testnet');
  yocto('owner.testnet').ft_transfer({ receiver_id: 'alice.testnet', amount: G(1000) });
  A.equal(bal('alice.testnet'), BigInt(G(995)));
  A.equal(c.ft_total_supply(), (BigInt(G(1_000_000_000)) - BigInt(G(5))).toString());
  A.equal(events('ft_burn').length, 1);
  A.equal(events('ft_transfer')[0].data[0].amount, G(995));
  invariant();
});
test('amount negatif / desimal / nol / bukan string ditolak', () => {
  fresh(); register('alice.testnet');
  for (const bad of ['-1', '1.5', '0', '', 'abc', 100]) {
    A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: 'alice.testnet', amount: bad }), /Invalid amount|must be > 0/);
  }
});
test('amount > u128 ditolak', () => {
  fresh(); register('alice.testnet');
  A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: 'alice.testnet', amount: (1n << 128n).toString() }), /u128/);
});
test('saldo kurang ditolak', () => {
  fresh(); register('alice.testnet'); register('bob.testnet');
  A.throws(() => yocto('alice.testnet').ft_transfer({ receiver_id: 'bob.testnet', amount: G(1) }), /Insufficient/);
});
test('transfer ke diri sendiri ditolak', () => {
  fresh();
  A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: 'owner.testnet', amount: G(1) }), /must differ/);
});
test('vault kontrak nggak bisa kirim/terima (anti drain stake)', () => {
  fresh(); register('alice.testnet');
  A.throws(() => yocto('owner.testnet').ft_transfer({ receiver_id: SELF, amount: G(1) }), /vault/);
  agents(['alice.testnet']);
  A.throws(() => yocto(SELF).ft_transfer({ receiver_id: 'alice.testnet', amount: G(1) }), /vault/);
});

section('ft_transfer_call / ft_resolve_transfer');
test('memanggil ft_on_transfer dengan jumlah bersih + callback resolve', () => {
  fresh(); register('dex.testnet');
  const p = yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1000), msg: '' });
  A.equal(p.calls[0].acct, 'dex.testnet'); A.equal(p.calls[0].name, 'ft_on_transfer');
  A.equal(p.calls[0].args.amount, G(995));
  A.equal(p.calls[1].acct, SELF); A.equal(p.calls[1].name, 'ft_resolve_transfer');
});
test('msg wajib ada', () => {
  fresh(); register('dex.testnet');
  A.throws(() => yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1) }), /msg/);
});
test('gas kurang ditolak', () => {
  fresh(); register('dex.testnet'); ctx.gas = 50n * 10n ** 12n;
  A.throws(() => yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1), msg: '' }), /gas/);
});
test('sisa gas diteruskan ke ft_on_transfer (bukan fixed 50 TGas)', () => {
  fresh(); register('dex.testnet');
  const p = yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1), msg: '' });
  A.ok(p.calls[0].gas > 200n * 10n ** 12n, `gas diteruskan: ${p.calls[0].gas}`);
});
test('resolve: receiver pakai sebagian -> sisa di-refund', () => {
  fresh(); register('dex.testnet');
  yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1000), msg: '' });
  const before = bal('owner.testnet');
  ctx.promiseResult = JSON.stringify(G(395));
  const used = as(SELF).ft_resolve_transfer({ sender_id: 'owner.testnet', receiver_id: 'dex.testnet', amount: G(995) });
  A.equal(used, G(600));
  A.equal(bal('owner.testnet'), before + BigInt(G(395)));
  A.equal(bal('dex.testnet'), BigInt(G(600)));
  invariant();
});
test('resolve: receiver gagal -> refund penuh', () => {
  fresh(); register('dex.testnet');
  yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1000), msg: '' });
  ctx.promiseResult = 'FAIL';
  A.equal(as(SELF).ft_resolve_transfer({ sender_id: 'owner.testnet', receiver_id: 'dex.testnet', amount: G(995) }), '0');
  A.equal(bal('dex.testnet'), 0n);
  invariant();
});
test('resolve: receiver klaim unused > amount -> di-cap', () => {
  fresh(); register('dex.testnet');
  yocto('owner.testnet').ft_transfer_call({ receiver_id: 'dex.testnet', amount: G(1000), msg: '' });
  ctx.promiseResult = JSON.stringify(G(999999));
  A.equal(as(SELF).ft_resolve_transfer({ sender_id: 'owner.testnet', receiver_id: 'dex.testnet', amount: G(995) }), '0');
  invariant();
});

section('Staking');
test('stake < 100 GRIND ditolak', () => {
  fresh(); register('alice.testnet');
  yocto('owner.testnet').ft_transfer({ receiver_id: 'alice.testnet', amount: G(500) });
  A.throws(() => as('alice.testnet').stake_agent({ amount: G(99) }), /Min 100/);
});
test('stake memindahkan token ke vault, supply tetap', () => {
  fresh(); agents(['alice.testnet'], 300);
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }).amount, G(300));
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }).reputation, '3');
  A.equal(c.get_agent_count(), 1);
  A.equal(c.get_burn_stats().staked, G(300));
  invariant();
});
test('top-up stake nambah agentCount cuma sekali', () => {
  fresh(); agents(['alice.testnet'], 300);
  as('alice.testnet').stake_agent({ amount: G(1) });
  A.equal(c.get_agent_count(), 1);
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }).amount, G(301));
});
test('REGRESI: unstake amount negatif ditolak (dulu bisa mint stake & reputasi)', () => {
  fresh(); agents(['eve.testnet'], 100);
  A.throws(() => yocto('eve.testnet').unstake_agent({ amount: '-999999999999' }), /Invalid amount/);
  A.equal(c.get_agent_info({ agent_id: 'eve.testnet' }).amount, G(100));
  invariant();
});
test('unstake wajib 1 yoctoNEAR', () => {
  fresh(); agents(['alice.testnet'], 300);
  A.throws(() => as('alice.testnet', 0n).unstake_agent({ amount: G(100) }), /1 yoctoNEAR/);
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }).amount, G(300));
});
test('unstake parsial & penuh', () => {
  fresh(); agents(['alice.testnet'], 300);
  yocto('alice.testnet').unstake_agent({ amount: G(100) });
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }).amount, G(200));
  yocto('alice.testnet').unstake_agent({ amount: G(200) });
  A.equal(c.get_agent_info({ agent_id: 'alice.testnet' }), null);
  A.equal(storage.has('stk:alice.testnet'), false, 'storageRemove, bukan string kosong');
  A.equal(c.get_agent_count(), 0);
  invariant();
});
test('sisa stake di bawah minimum ditolak', () => {
  fresh(); agents(['alice.testnet'], 150);
  A.throws(() => yocto('alice.testnet').unstake_agent({ amount: G(100) }), /Remaining stake/);
});
test('unstake lebih dari stake / tanpa stake ditolak', () => {
  fresh(); agents(['alice.testnet'], 100); register('bob.testnet');
  A.throws(() => yocto('alice.testnet').unstake_agent({ amount: G(101) }), /Not enough staked/);
  A.throws(() => yocto('bob.testnet').unstake_agent({ amount: G(1) }), /No active stake/);
});

section('Report & slash (quorum)');
const A3 = ['a1.testnet', 'a2.testnet', 'a3.testnet'];
test('1-2 laporan belum nge-slash', () => {
  fresh(); agents(['target.testnet', ...A3]);
  let r = as('a1.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'wash trading' });
  A.equal(r.slashed, false); A.equal(r.reports, 1);
  r = as('a2.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'wash trading' });
  A.equal(r.slashed, false);
  A.equal(c.get_agent_info({ agent_id: 'target.testnet' }).amount, G(1000));
});
test('laporan ke-3 eksekusi slash 10% (50% burn, 50% treasury)', () => {
  fresh(); agents(['target.testnet', ...A3]);
  const burnedBefore = BigInt(c.get_burn_stats().burned);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'botting' });
  const t = c.get_agent_info({ agent_id: 'target.testnet' });
  A.equal(t.amount, G(900)); A.equal(t.slash_count, 1); A.equal(t.reputation, '8');
  A.equal(c.get_treasury_balance(), G(50));
  A.equal(BigInt(c.get_burn_stats().burned) - burnedBefore, BigInt(G(50)));
  A.equal(c.get_pending_reports({ agent_id: 'target.testnet' }), null);
  A.equal(events('slash').length, 1);
  invariant();
});
test('REGRESI: satu reporter nggak bisa spam slash', () => {
  fresh(); agents(['target.testnet', 'eve.testnet'], 1000);
  as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  A.throws(() => as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /already reported/);
  A.equal(c.get_agent_info({ agent_id: 'target.testnet' }).amount, G(1000));
});
test('cooldown 7 hari setelah slash', () => {
  fresh(); agents(['target.testnet', ...A3, 'a4.testnet']);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  A.throws(() => as('a4.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /cooldown/);
  advance(7);
  as('a4.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
});
test('laporan kadaluarsa setelah 3 hari', () => {
  fresh(); agents(['target.testnet', ...A3]);
  as('a1.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  as('a2.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  advance(4);
  const r = as('a3.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  A.equal(r.slashed, false); A.equal(r.reports, 1);
});
test('reporter: wajib staked, stake >= 1 hari, nggak boleh lapor diri sendiri', () => {
  fresh(); agents(['target.testnet', 'a1.testnet']); register('nobody.testnet');
  A.throws(() => as('nobody.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /Only agents/);
  A.throws(() => as('target.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /yourself/);
  register('fresh.testnet');
  yocto('owner.testnet').ft_transfer({ receiver_id: 'fresh.testnet', amount: G(500) });
  as('fresh.testnet').stake_agent({ amount: G(100) });
  A.throws(() => as('fresh.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /1 day old/);
});
test('evidence kosong / kepanjangan ditolak', () => {
  fresh(); agents(['target.testnet', 'a1.testnet']);
  A.throws(() => as('a1.testnet').report_agent({ agent_id: 'target.testnet', evidence: '   ' }), /Evidence required/);
  A.throws(() => as('a1.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x'.repeat(281) }), /max 280/);
});
test('target nggak bisa kabur (unstake) selagi ada laporan aktif', () => {
  fresh(); agents(['target.testnet', 'a1.testnet']);
  as('a1.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  A.throws(() => yocto('target.testnet').unstake_agent({ amount: G(1000) }), /Pending reports/);
  advance(3);
  yocto('target.testnet').unstake_agent({ amount: G(1000) });
  invariant();
});

test('REGRESI: 1 griefer nggak bisa ngunci unstake selamanya (grace 1 hari)', () => {
  fresh(); agents(['target.testnet', 'eve.testnet']);
  as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  advance(3);
  A.throws(() => as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' }), /grace period/);
  yocto('target.testnet').unstake_agent({ amount: G(1000) });
  A.equal(c.get_agent_info({ agent_id: 'target.testnet' }), null);
  invariant();
});
test('setelah grace habis, ronde laporan baru boleh dimulai', () => {
  fresh(); agents(['target.testnet', 'eve.testnet']);
  as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  advance(4);
  const r = as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  A.equal(r.reports, 1);
});
test('REGRESI: unstake parsial tidak membatalkan grace', () => {
  fresh(); agents(['target.testnet', 'eve.testnet']);
  as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  advance(3);
  yocto('target.testnet').unstake_agent({ amount: G(1) });
  A.equal(c.get_agent_info({ agent_id: 'target.testnet' }).amount, G(999));
  A.throws(() => as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'lagi' }), /grace period/);
  advance(1);
  const r = as('eve.testnet').report_agent({ agent_id: 'target.testnet', evidence: 'ronde baru' });
  A.equal(r.reports, 1);
  A.equal(r.slashed, false);
});
test('slash boleh sisakan stake < 100; tetap agent, tidak bisa lapor', () => {
  fresh(); agents(['target.testnet', ...A3], 100);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  const t = c.get_agent_info({ agent_id: 'target.testnet' });
  A.equal(t.amount, G(90));
  A.equal(t.reputation, '0');
  A.equal(c.get_agent_count(), 4);
  A.throws(() => as('target.testnet').report_agent({ agent_id: 'a1.testnet', evidence: 'x' }), /Only agents/);
  invariant();
});

section('Ritual mingguan');
test('ritual pertama + cooldown 7 hari', () => {
  fresh();
  c.trigger_ritual();
  A.equal(c.get_ritual_status().ritual_count, 1);
  A.throws(() => c.trigger_ritual(), /once per 7 days/);
  advance(7); c.trigger_ritual();
  A.equal(c.get_ritual_status().ritual_count, 2);
});
test('treasury burn 10% saat burn organik naik, total supply turun', () => {
  fresh(); agents(['target.testnet', ...A3]);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  const supplyBefore = BigInt(c.ft_total_supply());
  const r = c.trigger_ritual();
  A.equal(r.treasury_burned, G(5));
  A.equal(c.get_treasury_balance(), G(45));
  A.equal(BigInt(c.ft_total_supply()), supplyBefore - BigInt(G(5)));
  A.equal(c.get_ritual_status().current_epoch_burn, '0');
  invariant();
});
test('treasury burn TIDAK dihitung ke epoch burn berikutnya', () => {
  fresh(); agents(['target.testnet', ...A3]);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  c.trigger_ritual();
  const lastEpoch = BigInt(c.get_ritual_status().last_epoch_burn);
  // epoch burn = burn organik saja (transfer setup + slash), tanpa 5 GRIND treasury burn
  A.ok(lastEpoch < BigInt(G(100)));
  A.equal(c.get_burn_stats().burned, (lastEpoch + BigInt(G(5))).toString());
});
test('nggak ada treasury burn kalau burn organik turun', () => {
  fresh(); agents(['target.testnet', ...A3]);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  c.trigger_ritual();
  advance(7);
  const r = c.trigger_ritual(); // epoch ini burn 0 < epoch lalu
  A.equal(r.treasury_burned, '0');
});

test('durasi epoch tercatat di status & event ritual', () => {
  fresh(); agents(['a.testnet', 'b.testnet'], 1000);
  c.trigger_ritual();                               // epoch 1: setup transfers
  advance(7);
  // epoch 2: burn 7 GRIND dalam 7 hari
  for (let i = 0; i < 7; i++) yocto('owner.testnet').ft_transfer({ receiver_id: 'a.testnet', amount: G(200) });
  c.trigger_ritual();
  // epoch 3: burn 8 GRIND total (lebih besar) tapi dalam 14 hari -> laju lebih kecil
  for (let i = 0; i < 8; i++) yocto('owner.testnet').ft_transfer({ receiver_id: 'b.testnet', amount: G(200) });
  advance(14);
  A.equal(c.get_ritual_status().current_epoch_burn, G(8));
  A.equal(c.get_ritual_status().last_epoch_burn, G(7));
  // treasury kosong di sini; yang dicek: epoch_duration tercatat & burnUp pakai laju
  const st = c.get_ritual_status();
  A.equal(st.last_epoch_duration_ns, (7n * DAY).toString());
  c.trigger_ritual();
  const ev = events('ritual').at(-1).data[0];
  A.equal(ev.epoch_duration_ns, (14n * DAY).toString());
});
test('treasury burn tetap jalan kalau laju burn naik', () => {
  fresh(); agents(['target.testnet', ...A3]);
  c.trigger_ritual(); advance(7);
  yocto('owner.testnet').ft_transfer({ receiver_id: 'a1.testnet', amount: G(1000) }); // epoch 2: 5 GRIND
  c.trigger_ritual(); advance(7);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' }); // epoch 3: slash 50 burn
  const r = c.trigger_ritual();
  A.equal(r.treasury_burned, G(5));
  invariant();
});
test('REGRESI: epoch pertama yang sangat pendek tidak mengunci laju', () => {
  fresh();
  register('burner.testnet');
  yocto('owner.testnet').ft_transfer({ receiver_id: 'burner.testnet', amount: G(1000) }); // bakar 5, durasi ~0
  const first = c.trigger_ritual();
  A.equal(first.treasury_burned, '0');
  A.equal(c.get_ritual_status().last_epoch_duration_ns, '1'); // durasi aktual tetap jujur
  A.equal(c.get_ritual_status().previous_rate_duration_ns, (7n * DAY).toString());
  agents(['target.testnet', ...A3], 100); // +2 hari, lalu slash di epoch ini
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' });
  advance(5); // epoch ini jadi 7 hari; bakar slash 5 GRIND > baseline 5 GRIND / 7 hari
  const st = c.get_ritual_status();
  A.equal(st.ritual_ready, true);
  A.equal(st.rate_ahead, true);
  A.equal(st.additional_burn_needed, '0');
  A.equal(st.treasury_burn_if_called_now, (ONE / 2n).toString());
  const r = c.trigger_ritual();
  A.equal(r.treasury_burned, (ONE / 2n).toString()); // 10% dari treasury slash 5 GRIND
  invariant();
});
test('laju burn turun -> treasury nggak dibakar walau totalnya lebih besar', () => {
  fresh(); agents(['target.testnet', ...A3]);
  for (const a of A3) as(a).report_agent({ agent_id: 'target.testnet', evidence: 'x' }); // treasury 50
  c.trigger_ritual(); advance(7);
  for (let i = 0; i < 2; i++) yocto('owner.testnet').ft_transfer({ receiver_id: 'a1.testnet', amount: G(1000) }); // 10 GRIND / 7 hari
  c.trigger_ritual();
  for (let i = 0; i < 3; i++) yocto('owner.testnet').ft_transfer({ receiver_id: 'a2.testnet', amount: G(1000) }); // 15 GRIND / 28 hari
  advance(28);
  const r = c.trigger_ritual();
  A.equal(r.treasury_burned, '0', 'total naik (15 > 10) tapi laju turun');
});

section('Invarian (fuzz kecil)');
test('200 operasi acak -> sum(balances) == total_supply', () => {
  fresh();
  const users = ['u1.testnet', 'u2.testnet', 'u3.testnet', 'u4.testnet', 'u5.testnet'];
  agents(users, 1000);
  let seed = 42; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let i = 0; i < 200; i++) {
    const u = users[rnd(5)], v = users[rnd(5)];
    const amt = G(1 + rnd(50));
    try {
      switch (rnd(5)) {
        case 0: yocto(u).ft_transfer({ receiver_id: v, amount: amt }); break;
        case 1: as(u).stake_agent({ amount: amt }); break;
        case 2: yocto(u).unstake_agent({ amount: amt }); break;
        case 3: as(u).report_agent({ agent_id: v, evidence: 'fuzz' }); break;
        case 4: advance(1); try { c.trigger_ritual(); } catch (_) {} break;
      }
    } catch (_) { /* operasi invalid boleh gagal */ }
    invariant();
  }
});

// ═════════════════════════════════════════════════════════════════
console.log(`\n${passed}/${total} passed`);
if (failed.length) { console.log('FAILED:\n - ' + failed.join('\n - ')); process.exit(1); }
