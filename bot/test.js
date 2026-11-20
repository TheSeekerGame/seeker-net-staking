/* node --test bot/test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../rules.js');
const { CONFIG, listingFromEvent, seconds, snapshotListings, prune } = require('./bot.js');

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), D = '0x' + 'd'.repeat(40);
const DAY = 86400, T0 = 1_800_000_000;
// startMax 7 keeps the start at a flat 7 in most tests below, so their sums stay simple;
// the start itself (7 per seeker, capped at 100) is tested on its own
const RULES = { start: 7, startMax: 7, perDay: 1, moveMax: 7 };
const LIVE = { ...CONFIG.rules };

/** A small collection: owners[i] holds seeker i+1. */
function genesis(owners, rules = RULES, listings = []) {
  const holders = [...new Set(owners)].sort();
  return { supply: owners.length, time: T0, block: 0, rules, holders, owner: owners.map(a => holders.indexOf(a)), listings };
}
const at = day => T0 + Math.round(day * DAY);
let n = 0;
const move = (day, id, from, to) => ({ k: 'move', t: at(day), b: ++n, i: 0, id, from, to, tx: '0x1' });
const cancel = (day, h, a) => ({ k: 'cancel', t: at(day), b: ++n, i: 0, h, a, tx: '0x2' });
const counter = (day, a) => ({ k: 'counter', t: at(day), b: ++n, i: 0, a, tx: '0x3' });
const adjust = (day, a, credits) => ({ k: 'adjust', t: at(day), a, credits, note: 'test' });
/** a listing of seeker `id` by `maker`, posted on day `from`, ending on day `to` */
const listing = (h, id, maker, from, to, s = 0) => ({ h, id, maker, t: at(from), s, e: at(to) });
const bal = (s, a) => s.accounts.get(a).units / DAY;          // in credits
const play = (g, events, listings, day) => Rules.replay(g, events, listings, at(day));

test('the live rules: 7 per seeker at the start (max 100), 1 a day, 7 with a move', () => {
  assert.deepEqual(LIVE, { start: 7, startMax: 100, perDay: 1, moveMax: 7 });
});

test('the start: 7 credits per seeker held, capped at 100 per wallet, listed seekers included', () => {
  const E = '0x' + 'e'.repeat(40);
  const owners = [A, B, B, B, ...Array(14).fill(C), ...Array(15).fill(D), ...Array(40).fill(E)];
  const g = genesis(owners, LIVE, [listing('0xh1', 2, B, -1, 5)]);
  const s = play(g, [], [], 0);
  assert.equal(bal(s, A), 7);
  assert.equal(bal(s, B), 21);
  assert.equal(bal(s, C), 98);
  assert.equal(bal(s, D), 100);
  assert.equal(bal(s, E), 100);
  assert.deepEqual(s.accounts.get(B).history[0], { t: T0, k: 'start', d: 21 * DAY, n: 3 });
});

test('an unlisted seeker earns 1 a day, by the second', () => {
  const g = genesis([A, A, A, B]);
  assert.equal(bal(play(g, [], [], 10), A), 7 + 30);
  assert.equal(bal(play(g, [], [], 10), B), 7 + 10);
  assert.equal(Rules.replay(g, [], [], T0 + 1).accounts.get(B).units, 7 * DAY + 1);
  assert.equal(bal(play(g, [], [], 0.5), A), 7 + 1.5);
});

test('a listing stops the earning from when it is posted until its end date', () => {
  const s = play(genesis([A, A]), [], [listing('0xh1', 1, A, 2, 5)], 10);
  assert.equal(bal(s, A), 7 + 10 + (10 - 3));
  const h = s.accounts.get(A).history;
  assert.deepEqual(h.filter(x => x.k !== 'start').map(x => [x.k, x.t, x.why]), [['list', at(2), undefined], ['unlist', at(5), 'ended']]);
});

test('a listing with a later signed start time counts from that time', () => {
  const s = play(genesis([A]), [], [listing('0xh1', 1, A, 1, 6, at(3))], 10);
  assert.equal(bal(s, A), 7 + 10 - 3);
});

test('a listing live at the start counts from the start until its end date', () => {
  const s = play(genesis([A], RULES, [listing('0xh0', 1, A, -5, 4)]), [], [], 10);
  assert.equal(bal(s, A), 7 + 6);
});

test('two listings of one seeker: listed while either is live', () => {
  const s = play(genesis([A]), [], [listing('0xh1', 1, A, 1, 4), listing('0xh2', 1, A, 3, 6)], 10);
  assert.equal(bal(s, A), 7 + 10 - 5);
});

test('an on-chain cancellation ends a listing at once; the free cancel is not on record and changes nothing', () => {
  const L = [listing('0xh1', 1, A, 1, 30)];
  assert.equal(bal(play(genesis([A]), [cancel(4, '0xh1', A)], L, 10), A), 7 + 10 - 3);
  assert.equal(bal(play(genesis([A]), [], L, 10), A), 7 + 1);           // listed from day 1 to the end date
});

test('CounterIncremented ends every listing its lister posted before it, and only those', () => {
  const L = [listing('0xh1', 1, A, 1, 30), listing('0xh2', 2, A, 2, 30), listing('0xh3', 3, A, 5, 6),
             listing('0xh4', 4, B, 1, 30)];
  const s = play(genesis([A, A, A, B]), [counter(4, A)], L, 10);
  assert.equal(bal(s, A), 7 + (10 - 3) + (10 - 2) + (10 - 1));         // 1: days 1-4, 2: days 2-4, 3: days 5-6
  assert.equal(bal(s, B), 7 + 1);                                       // B's listing is not touched
});

test('a listing signed before a CounterIncremented never goes live, even if scheduled after it', () => {
  const s = play(genesis([A]), [counter(2, A)], [listing('0xh1', 1, A, 1, 30, at(3))], 10);
  assert.equal(bal(s, A), 7 + 10);
});

test('a cancellation before the listing is posted keeps it from ever going live', () => {
  const s = play(genesis([A]), [cancel(1, '0xh1', A)], [listing('0xh1', 1, A, 2, 30)], 10);
  assert.equal(bal(s, A), 7 + 10);
});

test('a listing by someone who never holds the seeker counts for nothing', () => {
  const s = play(genesis([A, B]), [], [listing('0xh1', 1, B, 1, 30)], 10);
  assert.equal(bal(s, A), 7 + 10);
  assert.equal(bal(s, B), 7 + 10);
});

test('a sale ends the listing: the buyer earns from the moment it arrives', () => {
  const s = play(genesis([A]), [move(4, 1, A, B)], [listing('0xh1', 1, A, 1, 30)], 10);
  assert.equal(bal(s, A), 7 + 1 - 7);
  assert.equal(bal(s, B), 7 + 6);
  assert.equal(s.listed[1], 0);
});

test('a listing pauses while the seeker is in another wallet and counts again when it comes back', () => {
  const s = play(genesis([A]), [move(2, 1, A, B), move(3, 1, B, A)], [listing('0xh1', 1, A, 1, 30)], 10);
  assert.equal(s.listed[1], 1);
  assert.equal(bal(s, A), (7 + 1 - 7) + 7);                             // earned day 0-1, sold (-7), got 7 back, listed again from day 3
  assert.equal(bal(s, B), 7 + 1 - 7);                                   // B held it unlisted for a day
  assert.deepEqual(s.spans.get('0xh1'), [[at(1), at(2)], [at(3), null]]);
  // a listing that ended while the seeker was away does not come back
  const t = play(genesis([A]), [move(2, 1, A, B), move(5, 1, B, A)], [listing('0xh1', 1, A, 1, 4)], 10);
  assert.equal(t.listed[1], 0);
  // nor one cancelled on-chain while away
  const u = play(genesis([A]), [move(2, 1, A, B), cancel(2.5, '0xh1', A), move(3, 1, B, A)], [listing('0xh1', 1, A, 1, 30)], 10);
  assert.equal(u.listed[1], 0);
  // a listing posted by someone who gets the seeker later counts from then
  const v = play(genesis([A, B]), [move(4, 1, A, B)], [listing('0xh1', 1, B, 1, 30)], 10);
  assert.equal(v.listed[1], 1);
  assert.equal(bal(v, B), 7 + 10 + 7);                                  // seeker 2 earned all along; seeker 1 arrived listed
  // and moving out and back is no way to earn while listed
  const w = play(genesis([A, C]), [move(2, 1, A, C), move(2.001, 1, C, A)], [listing('0xh1', 1, A, 1, 30)], 10);
  assert.equal(w.listed[1], 1);
  assert.ok(bal(w, A) < 7 + 1.01);
});

test('a listing that was bought is over for good: it does not come back with the seeker', () => {
  const L = [listing('0xh1', 1, A, 1, 30)];
  // a sale: Seaport's OrderFulfilled and the Transfer are in one transaction, in either order
  const sale = fillFirst => {
    const b = ++n;
    return [{ k: 'move', t: at(2), b, i: fillFirst ? 5 : 1, id: 1, from: A, to: B, tx: '0x5' },
            { k: 'fill', t: at(2), b, i: fillFirst ? 1 : 5, h: '0xh1', a: A, tx: '0x5' }];
  };
  for (const fillFirst of [true, false]) {
    const s = play(genesis([A]), [...sale(fillFirst), move(3, 1, B, A)], L, 10);
    assert.equal(s.listed[1], 0);
    assert.equal(bal(s, A), (7 + 1 - 7) + 7 + 7);                       // earned day 0-1, sold (-7), bought back (+7), earning days 3-10
    assert.equal(bal(s, B), 7 + 1 - 7);
    assert.deepEqual(s.accounts.get(A).history.map(h => h.k), ['start', 'list', 'out', 'in']);
    assert.deepEqual(s.spans.get('0xh1'), [[at(1), at(2)]]);
    assert.equal(s.accounts.get(A).unlisted, 1);
  }
  // another listing of that seeker, not the one that was bought, still counts again
  const two = play(genesis([A]), [...sale(true), move(3, 1, B, A)], [...L, listing('0xh2', 1, A, 1.5, 30)], 10);
  assert.equal(two.listed[1], 1);
  assert.deepEqual([...two.live.keys()], ['0xh2']);
});

test('withdrawing OpenSea\'s permission pauses the lister\'s listings; granting it again brings back those not yet ended', () => {
  const approval = (day, a, on, b = ++n) => ({ k: 'approval', t: at(day), b, i: 0, a, on, tx: '0x6' });
  const L = [listing('0xh1', 1, A, 1, 30), listing('0xh2', 2, A, 1, 5)];
  const s = play(genesis([A, A]), [approval(3, A, false), approval(7, A, true)], L, 10);
  assert.equal(s.listed[1], 1);                                         // back from day 7
  assert.equal(s.listed[2], 0);                                         // ended on day 5, while paused
  assert.equal(bal(s, A), 7 + 2 + 2 * 4 + 1 * 3 + 0);                   // start 7 (capped); days 1-3 both listed; 3-7 both earn; 7-10 one earns
  assert.deepEqual(s.spans.get('0xh1'), [[at(1), at(3)], [at(7), null]]);
  // a listing posted while the permission is withdrawn waits for it
  const w = play(genesis([A]), [approval(0.5, A, false), approval(4, A, true)], [listing('0xh1', 1, A, 1, 30)], 10);
  assert.equal(bal(w, A), 7 + 4);
  // permissions before the start set who can list at the start; no event on record means allowed
  const g = genesis([A, B], RULES, [listing('0xs1', 1, A, -2, 30), listing('0xs2', 2, B, -2, 30)]);
  const before = { k: 'approval', t: at(-1), b: 0, i: 0, a: A, on: false, tx: '0x7' };
  const x = Rules.replay(g, [before], [], at(10));
  assert.equal(x.listed[1], 0);
  assert.equal(x.listed[2], 1);
  // and the order the record lists them in changes nothing
  const y = Rules.replay(g, [approval(3, B, false, 50), before].reverse(), [], at(10));
  assert.equal(y.listed[2], 0);
});

test('a move takes 7 of the sender\'s credits to the new owner; a short seller gives what they have', () => {
  const s = play(genesis([A, B]), [move(3, 1, A, C)], [], 3);
  assert.equal(bal(s, A), 7 + 3 - 7);
  assert.equal(bal(s, C), 7);
  const t = play(genesis([A]), [adjust(0, A, -4), move(0.0001, 1, A, C)], [], 0.0001);   // (corrections come after chain events of the same second)
  assert.equal(t.accounts.get(C).units, 3 * DAY + 9);                  // all A had: 3 credits and 9 seconds of earning
  assert.equal(t.accounts.get(A).units, 0);
});

test('flipping is neutral: a chain of flippers passes the full 7 along', () => {
  const E = '0x' + 'e'.repeat(40);
  const events = [move(0, 1, A, B), move(1, 1, B, C), move(2, 1, C, D), move(3, 1, D, E)];
  const L = [listing('0xb', 1, B, 0, 30), listing('0xc', 1, C, 1, 30), listing('0xd', 1, D, 2, 30)];
  const s = play(genesis([A]), events, L, 3);
  for (const w of [B, C, D]) assert.equal(bal(s, w), 0);
  assert.equal(bal(s, E), 7);
});

test('sales at the same moment: the first in chain order gets what is there', () => {
  const s = play(genesis([A, A, A], { ...RULES, startMax: 10 }), [move(0, 1, A, B), move(0, 2, A, C), move(0, 3, A, D)], [], 0);
  assert.deepEqual([bal(s, B), bal(s, C), bal(s, D), bal(s, A)], [7, 3, 0, 0]);
});

test('credits are never created by moves: passing a seeker round and round', () => {
  const events = [];
  for (let k = 0; k < 50; k++) events.push(move(0, 1, k % 2 ? B : A, k % 2 ? A : B));
  assert.equal(play(genesis([A, B]), events, [], 0).total, 14 * DAY);
});

test('the same records give the same balances, in whatever order the listings were found', () => {
  const g = genesis([A, A, B, C, C, C], LIVE, [listing('0xg', 4, C, -2, 3)]);
  const events = [move(2, 3, B, A), cancel(3, '0xh2', A), move(3.5, 5, C, D), counter(5, C), move(5.5, 6, C, A), adjust(6, D, 2)];
  const L = [listing('0xh1', 1, A, 1, 4), listing('0xh2', 2, A, 2, 9), listing('0xh3', 6, C, 4, 8),
             listing('0xh4', 5, D, 4, 4.5), listing('0xh5', 3, A, 2.5, 7), listing('0xh6', 3, A, 2.5, 3)];
  const ref = play(g, events, L, 9);
  const snap = s => JSON.stringify([...s.accounts.values()].map(x => [x.address, x.units, x.history]).sort());
  for (let k = 0; k < 20; k++) {
    const shuffled = L.map(l => [Math.sin(k * 97 + l.h.length * 13 + l.e), l]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    assert.equal(snap(play(g, events, shuffled, 9)), snap(ref));
  }
  let total = 0;
  for (const x of ref.accounts.values()) {
    assert.equal(x.units, x.start + x.earned + x.received - x.sent + x.adjusted);
    assert.equal(x.unlisted, Rules.seekersOf(ref, x.address).filter(m => !m.listed).length);
    assert.ok(x.units >= 0 && Number.isInteger(x.units));
    total += x.units;
  }
  assert.equal(total, ref.total);
});

test('chain events are played in chain order, however the record lists them', () => {
  const events = [move(1, 1, A, B), cancel(2, '0xh1', B), move(3, 1, B, C)];
  const L = [listing('0xh1', 1, B, 1.5, 9)];
  const a = play(genesis([A]), events, L, 5), b = play(genesis([A]), [events[2], events[0], events[1]], L, 5);
  assert.deepEqual([...a.accounts.values()].map(x => x.units), [...b.accounts.values()].map(x => x.units));
});

test('within one second: end dates first, then chain events, then new listings', () => {
  // a listing ends and another is posted in the same second as a sale: the new owner's listing counts
  const L = [listing('0xh1', 1, A, 1, 3), listing('0xh2', 1, B, 3, 6)];
  const s = play(genesis([A]), [move(3, 1, A, B)], L, 10);
  assert.equal(bal(s, B), 7 + 4);                                       // listed days 3-6, earning 6-10
});

test('a balance at an earlier moment ignores what came later', () => {
  assert.equal(bal(play(genesis([A, B]), [move(3, 1, A, B)], [listing('0xh1', 1, A, 2.5, 9)], 2), A), 9);
});

test('a record that does not fit the rules is refused', () => {
  const g = genesis([A, B]);
  assert.throws(() => play(g, [move(1, 1, B, C)], [], 5), /not held/);
  assert.throws(() => play(g, [], [listing('0xh', 1, A, 1, 2), listing('0xh', 1, A, 1, 2)], 5), /twice/);
  assert.throws(() => play(g, [adjust(1, A, 0.5)], [], 5), /whole credits/);
  assert.throws(() => play(genesis([A], RULES, [listing('0xh', 1, B, -1, 2)]), [], [], 5), /not by the holder/);
});

test('the start: OpenSea listings live at that moment, by the holder, are kept; the rest are not', () => {
  const T = 1_800_000_000, nft = CONFIG.nft;
  const owners = Array(2222).fill(B); owners[0] = A; owners[1] = A;
  const order = (h, id, maker, s, e, extra = {}) => ({ h, created: s, status: 'ACTIVE',
    parameters: { offerer: maker, startTime: String(s), endTime: String(e), offer: [{ token: nft, identifierOrCriteria: String(id) }] }, ...extra });
  const got = snapshotListings([
    order('0x1', 1, A, T - 100, T + 100),                                  // kept
    order('0x2', 2, A, T - 100, T - 1),                                    // ended before the start
    order('0x3', 1, B, T - 100, T + 100),                                  // not by the holder
    order('0x4', 2, A, T + 10, T + 100),                                   // starts after the start
    order('0x5', 2, A, T - 100, T + 100, { status: 'CANCELLED' }),         // not active
    order('0x6', 3, B, T - 100, T + 100, { parameters: { offerer: B, startTime: String(T - 100), endTime: String(T + 100), offer: [{ token: '0x' + '9'.repeat(40), identifierOrCriteria: '3' }] } }),
    order('0x1', 1, A, T - 100, T + 100),                                  // the same order twice
  ], owners, T);
  assert.deepEqual(got, [{ h: '0x1', id: 1, maker: A, t: T - 100, s: T - 100, e: T + 100 }]);
});

test('overlapping relistings are left out, and every balance stays exactly the same', () => {
  const g = genesis([A, A, B, C], LIVE);
  const L = [];
  // a bot relists seeker 1 every 20 seconds, each listing lasting 11 minutes, for 2 hours
  for (let k = 0; k < 360; k++) L.push({ h: '0xa' + k, id: 1, maker: A, t: at(1) + k * 20, s: 0, e: at(1) + k * 20 + 660 });
  // another relists seeker 3 the same way, and sells it half way; a third lists seeker 4 and cancels on-chain
  for (let k = 0; k < 120; k++) L.push({ h: '0xc' + k, id: 3, maker: B, t: at(2) + k * 30, s: 0, e: at(2) + k * 30 + 900 });
  L.push({ h: '0xd1', id: 4, maker: C, t: at(2), s: 0, e: at(9) }, { h: '0xd2', id: 4, maker: C, t: at(2) + 60, s: 0, e: at(2) + 600 });
  const chain = [move(2.02, 3, B, D), cancel(2.003, '0xd1', C)];
  const until = at(5);
  const kept = prune(g, chain, L, until);
  assert.ok(kept.length < L.length / 10, `kept ${kept.length} of ${L.length}`);
  const numbers = s => [...s.accounts.values()].map(x => [x.address, x.units, x.earned, x.unlisted].join()).sort().join('|');
  assert.equal(numbers(Rules.replay(g, chain, kept, until)), numbers(Rules.replay(g, chain, L, until)));
  // a listing live twice (its seeker went away and came back) is kept
  const twice = [...L, { h: '0xf1', id: 2, maker: A, t: at(3), s: 0, e: at(4) }];
  const back = chain.concat(move(3.2, 2, A, D), move(3.4, 2, D, A));
  const keptBack = prune(g, back, twice, until);
  assert.ok(keptBack.some(l => l.h === '0xf1'));
  assert.equal(numbers(Rules.replay(g, back, keptBack, until)), numbers(Rules.replay(g, back, twice, until)));
  // listings that can still matter are always kept
  const open = [...L, { h: '0xe1', id: 2, maker: A, t: at(4.9), s: 0, e: at(6) }];
  assert.ok(prune(g, chain, open, until).some(l => l.h === '0xe1'));
});

// ---- reading OpenSea's history

test('OpenSea listing events become listing records; anything else is left out', () => {
  const ev = { event_type: 'order', order_type: 'listing', chain: 'robinhood', order_hash: '0xABC',
               maker: '0x' + 'A'.repeat(40), asset: { identifier: '17', contract: CONFIG.nft },
               event_timestamp: 1800000100, start_date: 1800000100, expiration_date: 1800086500, is_private_listing: false };
  assert.deepEqual(listingFromEvent(ev), { h: '0xabc', id: 17, maker: A, t: 1800000100, s: 1800000100, e: 1800086500 });
  assert.equal(listingFromEvent({ ...ev, order_type: 'item_offer' }), null);
  assert.equal(listingFromEvent({ ...ev, asset: { identifier: '17', contract: '0x' + '9'.repeat(40) } }), null);
  assert.equal(listingFromEvent({ ...ev, asset: null }), null);
  assert.equal(listingFromEvent({ ...ev, event_type: 'listing', order_type: undefined, maker: { address: A } }).maker, A);
  assert.equal(listingFromEvent({ ...ev, is_private_listing: true }).p, 1);
});

test('OpenSea times in seconds, milliseconds or dates all become unix seconds', () => {
  assert.equal(seconds(1800000000), 1800000000);
  assert.equal(seconds('1800000000'), 1800000000);
  assert.equal(seconds(1800000000123), 1800000000);
  assert.equal(seconds('2027-01-15T08:00:00'), Date.UTC(2027, 0, 15, 8) / 1000);
  assert.equal(seconds('2027-01-15T08:00:00Z'), Date.UTC(2027, 0, 15, 8) / 1000);
  assert.equal(seconds(null), 0);
});
