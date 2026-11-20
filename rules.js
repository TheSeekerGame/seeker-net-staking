/* SEEKER NET credits: the rules.

   This one file is the whole calculation. The bot uses it and the website uses
   it, so both always agree. It only does arithmetic on whole numbers.

   Everything it reads is a permanent public record, so anyone who reads the
   same records gets exactly the same balance for every wallet, to the unit:
     data/genesis.json   the start: its block and time, who held every seeker
                         (from the chain), and the OpenSea listings live at that
                         moment, read from OpenSea then and published with
                         their orders as OpenSea served them (data/orders.jsonl)
     data/events.jsonl   every move of a seeker since the start (its Transfer
                         events, in chain order), every ApprovalForAll for
                         OpenSea's conduit since the contract began (who lets
                         OpenSea move their seekers), plus corrections made by
                         hand
     data/cancels.jsonl  the on-chain cancellations and sales that end a seeker
                         listing: Seaport's OrderCancelled or OrderFulfilled for
                         a listing in the record, and CounterIncremented by a
                         lister after one of their listings was posted and
                         before its end date
     data/listings.jsonl the OpenSea listings of seekers posted since the
                         start, from OpenSea's listing history: when each was
                         posted, by whom, and the end date it was signed with.
                         Relistings that overlap another listing of the same
                         seeker are left out once they end: they change no
                         balance
   When the bot looked at any of it never matters.

   THE RULES
   1. At the start every address holding seekers gets 7 credits for each seeker
      it holds, capped at 100 credits per wallet.
   2. Every seeker that is not listed earns its owner 1 credit per day, counted
      by the second. A listed seeker earns nothing.
   3. A seeker is listed while it has at least one live OpenSea listing. A
      listing is valid from the moment it was posted (or its signed start time,
      if later) until the first of:
        - the end date it was signed with,
        - an on-chain cancellation: Seaport's OrderCancelled for that order, or
          CounterIncremented by the lister (which ends all the listings they
          posted before it),
        - its own sale: Seaport's OrderFulfilled for that order (a listing can
          be bought only once).
      A valid listing is live whenever its lister holds the seeker and lets
      OpenSea move their seekers (ApprovalForAll for OpenSea's conduit on the
      SEEKER NET contract): it pauses while the seeker is in another wallet or
      that permission is withdrawn, and counts again when both are back, since
      it can then be bought again. A wallet with no such event on record counts
      as having the permission (OpenSea asks for it before the first listing).
      A cancellation that doesn't go on-chain leaves no public record of when it
      happened, so it does not end a listing early.
   4. When a seeker changes wallet (a sale or a plain transfer), 7 of the
      sender's credits go with it to the new owner (all they have, if fewer).
   5. Credits belong to an address. Nothing else creates or moves them.

   ORDER: everything is played in time order. Within the same second: listings
   reaching their end date first, then chain events in chain order, then newly
   posted listings, by order hash.

   Balances are kept in units: 1 credit = 86,400 units, so one unit is what one
   seeker earns in one second and nothing is ever rounded.
*/
(function (root) {
  'use strict';

  const DAY = 86400;
  const UNIT = DAY;                       // units per credit

  /** When a listing becomes live: posted, or its signed start time if later. */
  const liveFrom = l => Math.max(l.t, l.s || 0);

  /** Play everything from the start. `until` (unix seconds) is the moment the
      balances are worked out for; it defaults to the last thing that happened. */
  function replay(genesis, events, listings, until) {
    const R = genesis.rules;
    const perSecond = R.perDay;           // units a seeker earns per second
    const N = genesis.supply;
    const owner = new Array(N + 1).fill(null);
    const valid = new Map();              // order hash -> listing, from when it is posted until its end date or cancellation
    const validOn = Array.from({ length: N + 1 }, () => new Set());  // seeker -> valid order hashes
    const live = new Map();               // order hash -> listing, while valid and its lister holds the seeker
    const liveOn = Array.from({ length: N + 1 }, () => new Set());   // seeker -> live order hashes
    const cancelled = new Set();          // order hashes cancelled on-chain, or bought
    const counterAt = new Map();          // lister -> time of their last CounterIncremented
    const approved = new Map();           // address -> whether OpenSea may move their seekers (no entry: yes)
    const allowed = a => approved.get(a) !== false;
    const accounts = new Map();
    const spans = new Map();              // order hash -> [[live from, live until], ...] (until null while live)
    let now = genesis.time;

    function account(a) {
      let x = accounts.get(a);
      if (!x) {
        x = { address: a, units: 0, since: now, unlisted: 0, held: 0,
              start: 0, earned: 0, sent: 0, received: 0, adjusted: 0, history: [] };
        accounts.set(a, x);
      }
      return x;
    }
    // rule 2: bring an account's earnings up to `now`
    function settle(x) {
      const gain = (now - x.since) * x.unlisted * perSecond;
      x.units += gain;
      x.earned += gain;
      x.since = now;
      return x;
    }
    // rule 3: a listing goes live (its lister holds the seeker), or stops being live
    function start(l) {
      if (liveOn[l.id].size === 0) {
        const x = settle(account(l.maker));
        x.unlisted--;
        x.history.push({ t: now, k: 'list', id: l.id, d: 0, until: l.e });
      }
      live.set(l.h, l);
      liveOn[l.id].add(l.h);
      if (!spans.has(l.h)) spans.set(l.h, []);
      spans.get(l.h).push([now, null]);
    }
    function invalidate(h, why) {
      const l = valid.get(h);
      if (!l) return;
      valid.delete(h);
      validOn[l.id].delete(h);
      end(h, why);
    }
    function end(h, why) {
      const l = live.get(h);
      if (!l) return;
      live.delete(h);
      const s = spans.get(h);
      s[s.length - 1][1] = now;
      liveOn[l.id].delete(h);
      if (liveOn[l.id].size === 0 && why !== 'moved') {
        const x = settle(account(owner[l.id]));
        x.unlisted++;
        if (why !== 'sold') x.history.push({ t: now, k: 'unlist', id: l.id, d: 0, why });   // a sale shows as the move that comes with it
      }
    }

    // rule 1
    for (let id = 1; id <= N; id++) {
      const a = genesis.holders[genesis.owner[id - 1]];
      owner[id] = a;
      const x = account(a);
      x.held++;
      x.unlisted++;
    }
    for (const x of accounts.values()) {
      x.start = x.units = Math.min(R.start * x.held, R.startMax ?? Infinity) * UNIT;
      x.history.push({ t: now, k: 'start', d: x.start, n: x.held });
    }
    // the listings live at the start
    const steps = [];
    // who let OpenSea move their seekers at the start (the permissions given or withdrawn up to the start block)
    const atStart = e => e.k === 'approval' && e.b <= genesis.block;
    for (const e of events.filter(atStart).sort((x, y) => x.b - y.b || x.i - y.i)) approved.set(e.a, e.on);
    events = events.filter(e => !atStart(e));
    for (const l of genesis.listings || []) {
      if (owner[l.id] !== l.maker) throw new Error(`start: listing ${l.h} is not by the holder of seeker ${l.id}`);
      valid.set(l.h, l);
      validOn[l.id].add(l.h);
      steps.push({ t: l.e, phase: 0, key: l.h, end: l.h });
      if (!allowed(l.maker)) continue;
      if (liveOn[l.id].size === 0) account(l.maker).unlisted--;
      live.set(l.h, l);
      liveOn[l.id].add(l.h);
      spans.set(l.h, [[genesis.time, null]]);
    }

    // everything since, in time order (see ORDER above); chain events in chain
    // order (block, then position in the block), corrections after them
    const chainKey = e => [e.t, e.b ?? Infinity, e.i ?? 0];
    const ordered = events.map((e, n) => [chainKey(e), n, e])
      .sort((x, y) => x[0][0] - y[0][0] || x[0][1] - y[0][1] || x[0][2] - y[0][2] || x[1] - y[1]);
    ordered.forEach(([, , e], n) => steps.push({ t: e.t, phase: 1, key: n, e }));
    const seen = new Set();
    for (const l of listings) {
      if (seen.has(l.h)) throw new Error(`listing ${l.h} is in the record twice`);
      seen.add(l.h);
      const from = liveFrom(l);
      if (from < genesis.time || l.e <= from) continue;    // before the start (see genesis), or never live
      steps.push({ t: from, phase: 2, key: l.h, l });
      steps.push({ t: l.e, phase: 0, key: l.h, end: l.h });
    }
    steps.sort((a, b) => a.t - b.t || a.phase - b.phase ||
      (a.phase === 1 ? a.key - b.key : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    for (const step of steps) {
      if (until !== undefined && step.t > until) break;
      now = Math.max(now, step.t);
      if (step.end) { invalidate(step.end, 'ended'); continue; }

      if (step.l) {                                         // a listing is posted
        const l = step.l;
        if (cancelled.has(l.h) || l.t < (counterAt.get(l.maker) ?? -Infinity)) continue;
        valid.set(l.h, l);
        validOn[l.id].add(l.h);
        if (owner[l.id] === l.maker && allowed(l.maker)) start(l);
        continue;
      }

      const e = step.e;
      if (e.k === 'move') {                                 // rule 4
        if (owner[e.id] !== e.from) throw new Error(`seeker ${e.id} is not held by ${e.from} at ${e.tx}`);
        if (e.from === e.to) continue;
        const from = settle(account(e.from)), to = settle(account(e.to));
        const give = Math.min(R.moveMax * UNIT, from.units);
        from.units -= give; from.sent += give;
        to.units += give; to.received += give;
        const wasListed = liveOn[e.id].size > 0;
        for (const h of [...liveOn[e.id]]) end(h, 'moved');  // the lister no longer holds it: paused
        from.held--; to.held++; to.unlisted++;
        if (!wasListed) from.unlisted--;
        owner[e.id] = e.to;
        from.history.push({ t: now, k: 'out', id: e.id, d: -give, who: e.to, tx: e.tx });
        to.history.push({ t: now, k: 'in', id: e.id, d: give, who: e.from, tx: e.tx });
        if (allowed(e.to)) for (const h of [...validOn[e.id]]) if (valid.get(h).maker === e.to) start(valid.get(h));   // back with its lister
      } else if (e.k === 'cancel') {                        // Seaport OrderCancelled
        cancelled.add(e.h);
        invalidate(e.h, 'cancelled');
      } else if (e.k === 'fill') {                          // Seaport OrderFulfilled: the listing was bought, so it can never be bought again
        cancelled.add(e.h);
        invalidate(e.h, 'sold');
      } else if (e.k === 'counter') {                       // Seaport CounterIncremented: all of the lister's orders so far
        counterAt.set(e.a, e.t);
        for (const [h, l] of [...valid]) if (l.maker === e.a) invalidate(h, 'cancelled');
      } else if (e.k === 'approval') {                      // ApprovalForAll for OpenSea's conduit: can OpenSea move their seekers?
        if (allowed(e.a) === e.on) { approved.set(e.a, e.on); continue; }
        approved.set(e.a, e.on);
        if (!e.on) { for (const [h, l] of [...live]) if (l.maker === e.a) end(h, 'paused'); }
        else for (const l of [...valid.values()]) if (l.maker === e.a && owner[l.id] === e.a && !live.has(l.h)) start(l);
      } else if (e.k === 'adjust') {                        // a correction made by hand, with its reason
        if (!Number.isInteger(e.credits)) throw new Error(`a correction is in whole credits (${e.note})`);
        const x = settle(account(e.a));
        const d = Math.max(e.credits * UNIT, -x.units);
        x.units += d; x.adjusted += d;
        x.history.push({ t: now, k: 'adjust', d, note: e.note });
      } else {
        throw new Error(`unknown kind of event: ${e.k}`);
      }
    }

    if (until !== undefined && until > now) now = until;
    let total = 0, listedCount = 0;
    for (const x of accounts.values()) total += settle(x).units;
    const listed = new Uint8Array(N + 1);
    for (let id = 1; id <= N; id++) if (liveOn[id].size) { listed[id] = 1; listedCount++; }
    return { time: now, accounts, owner, listed, live, spans, total, listedCount, supply: N };
  }

  /** The seekers an address holds: [{id, listed}] */
  function seekersOf(state, address) {
    const out = [];
    for (let id = 1; id <= state.supply; id++) {
      if (state.owner[id] === address) out.push({ id, listed: !!state.listed[id] });
    }
    return out;
  }

  /** units -> "12.34" */
  function credits(units, places) {
    return (units / UNIT).toFixed(places === undefined ? 2 : places);
  }

  /** a .jsonl file -> array */
  function parseLines(text) {
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  const api = { DAY, UNIT, liveFrom, replay, seekersOf, credits, parseLines, parseEvents: parseLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SeekerCredits = api;
})(typeof self !== 'undefined' ? self : this);
