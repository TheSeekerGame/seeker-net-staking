#!/usr/bin/env node
/* SEEKER NET credits: the bot.

   node bot/bot.js check               read-only: can the bot read the chain and OpenSea right now? writes nothing
   node bot/bot.js run                 one round: copy the new public records into data/
   node bot/bot.js verify              rebuild data/ from the chain and OpenSea's history and compare
   node bot/bot.js balance 0xADDRESS   an address's balance and history
   node bot/bot.js totals              the whole picture in a few numbers
   node bot/bot.js publish DIR         ready-made results for the page: DIR/data/summary.json and
                                       DIR/data/wallets/<address>.json (worked out from the records)

   The bot decides nothing. It copies public records into data/, and rules.js
   works the balances out from them (see the top of rules.js):
     genesis.json   made once, by the first `run`: the start
     events.jsonl   every move of a seeker since the start, in chain order
     cancels.jsonl  the on-chain cancellations that can end a seeker listing
     listings.jsonl OpenSea listings of seekers that went live after the start
     orders.jsonl   the signed orders behind those listings, where OpenSea still
                    serves them (an archive: the rules never read it)
     head.json      how far the copy goes
   When a round runs, or whether one is missed, changes nothing: the next round
   copies the same records. `verify` rebuilds everything from scratch.

   No packages needed (Node 18 or newer). The OpenSea key comes from the
   OPENSEA_API_KEY environment variable; without one the bot takes one of
   OpenSea's free keys (no account needed, valid 7 days) and renews it itself.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const Rules = require('../rules.js');

const CONFIG = {
  rpc: process.env.SEEKER_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
  chain: 'robinhood',                                   // OpenSea's name for the chain
  nft: '0x5ac790269a6c71a51ba68bf6a3a2647f86788792',    // SEEKER NET
  slug: 'seeker-net',                                   // the collection's name in OpenSea's addresses
  seaports: ['0x0000000000000068f116a894984e2db1123eb395'],   // Seaport 1.6, which OpenSea uses on this chain
  supply: 2222,
  firstBlock: 83689515,                                 // the contract's first event: nothing to read before it
  rules: { start: 7, startMax: 100, perDay: 1, moveMax: 7 },   // start: per seeker held, capped at startMax credits per wallet
  lag: 30,            // stay this many blocks (a few seconds) behind the newest one
  settle: 3600,       // OpenSea's history can take a while to fill in: verify only compares listings older than this,
  reread: 3 * 3600,   // and every round re-reads this much of OpenSea's listing history (trading bots post thousands a day)
  opensea: 'https://api.opensea.io/api/v2',
};
const ROOT = path.join(__dirname, '..');
const DATA = process.env.CREDITS_DATA || path.join(ROOT, 'data');
const KEY_FILE = process.env.OPENSEA_KEY_FILE || path.join(ROOT, '.opensea-key.json');
const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',   // Transfer(address,address,uint256)
  cancel: '0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d',     // OrderCancelled(bytes32,address,address)
  counter: '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f',    // CounterIncremented(uint256,address)
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => '0x' + n.toString(16);
const addr = topic => '0x' + topic.slice(-40).toLowerCase();
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- the chain

async function post(body) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const r = await fetch(CONFIG.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
                                          body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
      last = new Error(`RPC answered ${r.status}`);
    } catch (e) { last = e; }
    await sleep(2500 * (attempt + 1));
  }
  throw last;
}

async function rpc(method, params) {
  const r = await post({ jsonrpc: '2.0', id: 1, method, params });
  if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
  return r.result;
}

/** Several requests in one go; answers in the same order. */
async function rpcBatch(requests) {
  const out = [];
  for (let i = 0; i < requests.length; i += 25) {             // the public RPC refuses large batches
    if (i) await sleep(120);
    const part = requests.slice(i, i + 25).map((q, n) => ({ jsonrpc: '2.0', id: n, method: q[0], params: q[1] }));
    let answer;
    for (let attempt = 0; ; attempt++) {
      answer = await post(part);
      if (Array.isArray(answer) && answer.length === part.length && answer.every(a => a.result)) break;
      if (attempt === 5) throw new Error('the RPC did not answer a batch: ' + JSON.stringify(answer).slice(0, 300));
      await sleep(2000 * (attempt + 1));
    }
    answer.sort((a, b) => a.id - b.id);
    for (const a of answer) out.push(a.result);
  }
  return out;
}

async function blockAt(number) {
  const b = await rpc('eth_getBlockByNumber', [number === 'latest' ? 'latest' : hex(number), false]);
  return { number: Number(b.number), time: Number(b.timestamp) };
}

/** The last block at or before a moment. */
async function blockBefore(time) {
  const latest = await blockAt('latest');
  let lo = CONFIG.firstBlock, hi = latest.number;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await blockAt(mid)).time <= time) lo = mid; else hi = mid;
  }
  return blockAt(lo);
}

/** Logs in blocks from..to, in chain order; the range is split when the RPC wants it smaller. */
async function logs(filter, from, to, span = 5000000) {
  const out = [];
  for (let lo = from; lo <= to;) {
    const hi = Math.min(lo + span - 1, to);
    try {
      out.push(...await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(lo), toBlock: hex(hi) }]));
      lo = hi + 1;
    } catch (e) {
      if (!e.rpc || span <= 500) throw e;
      span = Math.floor(span / 5);
    }
  }
  return out;
}
const chainOrder = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);

const transferLogs = async (from, to) => (await logs({ address: CONFIG.nft, topics: [TOPIC.transfer] }, from, to)).sort(chainOrder);

/** Seaport cancellations in blocks from..to, optionally only by some offerers. */
async function seaportLogs(from, to, offerers) {
  const out = [];
  for (const address of CONFIG.seaports) {
    if (!offerers) { out.push(...await logs({ address, topics: [[TOPIC.cancel, TOPIC.counter]] }, from, to)); continue; }
    const list = [...offerers];
    for (let i = 0; i < list.length; i += 100) {
      const who = list.slice(i, i + 100).map(a => '0x' + a.slice(2).padStart(64, '0'));
      out.push(...await logs({ address, topics: [[TOPIC.cancel, TOPIC.counter], who] }, from, to, 100000));   // the RPC takes lists of addresses over at most 100,000 blocks
    }
  }
  return out.sort(chainOrder);
}

/** Block number -> time, for a set of blocks. */
async function blockTimes(numbers) {
  const list = [...new Set(numbers.map(Number))];
  const stamps = await rpcBatch(list.map(b => ['eth_getBlockByNumber', [hex(b), false]]));
  return new Map(list.map((b, i) => [b, Number(stamps[i].timestamp)]));
}

/** Who holds each seeker after a block (['0x..'] for seekers 1..supply), with
    `lastMove`: the block of each seeker's last move. From every Transfer since
    the contract began, so anyone can redo it (the public RPC keeps no old state). */
async function ownersAt(block) {
  const owners = new Array(CONFIG.supply).fill(null), lastMove = new Array(CONFIG.supply).fill(0);
  for (const l of await transferLogs(CONFIG.firstBlock, block)) {
    const id = Number(BigInt(l.topics[3]));
    owners[id - 1] = addr(l.topics[2]);
    lastMove[id - 1] = Number(l.blockNumber);
  }
  if (owners.includes(null)) throw new Error('not every seeker has an owner in the Transfer events');
  return Object.assign(owners, { lastMove });
}

/** Every move of a seeker in blocks from..to, as records, in chain order. */
async function moveEvents(from, to) {
  const moves = await transferLogs(from, to);
  const time = await blockTimes(moves.map(l => l.blockNumber));
  return moves.map(l => ({ k: 'move', t: time.get(Number(l.blockNumber)), b: Number(l.blockNumber), i: Number(l.logIndex),
                           id: Number(BigInt(l.topics[3])), from: addr(l.topics[1]), to: addr(l.topics[2]), tx: l.transactionHash }));
}

/** Of the Seaport logs of listers' wallets, the cancellations that can end a
    seeker listing, as records (see rules.js): OrderCancelled for a listing in
    the record, and CounterIncremented after one of the lister's listings was
    posted and before its end date. Everything else those wallets cancel (their
    offers, other collections) is left out. */
async function cancelEvents(seaport, listings) {
  const hashes = new Set(listings.map(l => l.h));
  const byMaker = new Map();
  for (const l of listings) { if (!byMaker.has(l.maker)) byMaker.set(l.maker, []); byMaker.get(l.maker).push(l); }
  const candidates = seaport.filter(l => l.topics[0] === TOPIC.cancel ? hashes.has(l.data.slice(0, 66).toLowerCase()) : byMaker.has(addr(l.topics[1])));
  const time = await blockTimes(candidates.map(l => l.blockNumber));
  const out = [];
  for (const l of candidates) {
    const base = { t: time.get(Number(l.blockNumber)), b: Number(l.blockNumber), i: Number(l.logIndex) };
    if (l.topics[0] === TOPIC.cancel) out.push({ k: 'cancel', ...base, h: l.data.slice(0, 66).toLowerCase(), a: addr(l.topics[1]), tx: l.transactionHash });
    else if (byMaker.get(addr(l.topics[1])).some(x => x.t < base.t && base.t < x.e)) out.push({ k: 'counter', ...base, a: addr(l.topics[1]), tx: l.transactionHash });
  }
  return out.sort((a, b) => a.b - b.b || a.i - b.i);
}

// ---------------------------------------------------------------- OpenSea

async function mintKey() {
  const r = await fetch(CONFIG.opensea + '/auth/keys', { method: 'POST', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`OpenSea gave no free key (${r.status})`);
  const k = await r.json();
  const until = Date.parse(k.expires_at) || Date.now() + 7 * 86400e3;
  fs.writeFileSync(KEY_FILE, JSON.stringify({ api_key: k.api_key, until }), { mode: 0o600 });
  console.log(`took a free OpenSea key, valid until ${new Date(until).toISOString()}`);
  return k.api_key;
}

async function openseaKey(fresh) {
  if (process.env.OPENSEA_API_KEY) return process.env.OPENSEA_API_KEY;
  if (!fresh && fs.existsSync(KEY_FILE)) {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (k.until - Date.now() > 12 * 3600e3) return k.api_key;      // renew half a day early
  }
  return mintKey();
}

async function opensea(pathAndQuery) {
  let key = await openseaKey(false);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(CONFIG.opensea + pathAndQuery, { headers: { 'x-api-key': key, accept: 'application/json' },
                                                           signal: AbortSignal.timeout(60000) }).catch(e => ({ ok: false, status: 0, error: e }));
    if (r.ok) return r.json();
    if (attempt >= 5) throw new Error(`OpenSea answered ${r.status} for ${pathAndQuery.split('?')[0]}`);
    if ((r.status === 401 || r.status === 403) && !process.env.OPENSEA_API_KEY) key = await openseaKey(true);
    else if (r.status === 429) await sleep(1000 * Math.min(Number(r.headers.get('retry-after')) || 10, 120));
    else if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error(`OpenSea answered ${r.status} for ${pathAndQuery.split('?')[0]}`);
    else await sleep(3000 * (attempt + 1));
  }
}

/** a time in OpenSea's answers (seconds, milliseconds or a date) -> unix seconds */
function seconds(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) { const n = Number(v); return Math.floor(n > 1e12 ? n / 1000 : n); }
  const s = String(v);
  return Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z') / 1000) || 0;
}

/** One event of OpenSea's listing history -> a listing record, or null if it is not a listing of a seeker. */
function listingFromEvent(ev) {
  const type = String(ev.event_type || '').toLowerCase(), order = String(ev.order_type || '').toLowerCase();
  if (type !== 'listing' && !order.includes('listing')) return null;
  const asset = ev.asset || ev.nft;
  if (!asset || asset.identifier === undefined || asset.identifier === null || !ev.order_hash) return null;
  if (asset.contract && String(asset.contract).toLowerCase() !== CONFIG.nft) return null;
  if (ev.chain && ev.chain !== CONFIG.chain) return null;
  const maker = String(typeof ev.maker === 'string' ? ev.maker : ev.maker && ev.maker.address || '').toLowerCase();
  const t = seconds(ev.event_timestamp), s = seconds(ev.start_date), e = seconds(ev.expiration_date);
  if (!/^0x[0-9a-f]{40}$/.test(maker) || !t || !e) return null;
  const l = { h: String(ev.order_hash).toLowerCase(), id: Number(asset.identifier), maker, t, s: Math.max(s, 0), e };
  if (ev.is_private_listing) l.p = 1;
  return l;
}

/** OpenSea's listing history of the collection, posted in [after, before], oldest first. */
async function listingHistory(after, before) {
  const out = new Map(), cursors = new Set();
  let next = null, events = 0, oldest = Infinity;
  for (let page = 0; page < 5000; page++) {
    const q = `/events/collection/${CONFIG.slug}?event_type=listing&limit=200&after=${after}&before=${before}` +
              (next ? '&next=' + encodeURIComponent(next) : '');
    const r = await opensea(q);
    if (!Array.isArray(r.asset_events)) throw new Error('OpenSea sent no list of events');
    for (const ev of r.asset_events) {
      events++;
      oldest = Math.min(oldest, seconds(ev.event_timestamp) || oldest);
      const l = listingFromEvent(ev);
      if (l) out.set(l.h, l);
    }
    if (page === 0 && r.asset_events[0]) console.log('  OpenSea: first event as sent: ' + JSON.stringify(r.asset_events[0]).slice(0, 700));
    if (page % 10 === 9) console.log(`  OpenSea listing history: ${page + 1} pages, ${events} events, ${out.size} listings of seekers, back to ${new Date(oldest * 1000).toISOString()}`);
    next = r.next;
    const done = !next || !r.asset_events.length || cursors.has(next) || oldest < after;
    if (next) cursors.add(next);
    if (done) {
      console.log(`  OpenSea listing history: ${page + 1} pages, ${events} events, ${out.size} listings of seekers`);
      return [...out.values()].sort((a, b) => a.t - b.t || (a.h < b.h ? -1 : 1));
    }
  }
  throw new Error('OpenSea kept sending pages');
}

/** The signed orders behind the collection's current listings (for the archive). */
async function currentOrders() {
  const out = [];
  let next = null;
  for (let page = 0; page < 200; page++) {
    const r = await opensea(`/listings/collection/${CONFIG.slug}/all?limit=200&include_private_listings=true` + (next ? '&next=' + encodeURIComponent(next) : ''));
    if (!Array.isArray(r.listings)) throw new Error('OpenSea sent no list of listings');
    for (const l of r.listings) {
      if (l.order_hash && l.protocol_data) out.push({ h: l.order_hash.toLowerCase(), protocol: String(l.protocol_address || '').toLowerCase(),
                                                      created: seconds(l.order_created_at), status: String(l.status || 'ACTIVE').toUpperCase(),
                                                      parameters: l.protocol_data.parameters, signature: l.protocol_data.signature });
    }
    next = r.next;
    if (!next) return out;
  }
  return out;
}

// ---------------------------------------------------------------- the start

/** The listings live at the start: OpenSea's active listings of seekers read at
    the start, kept if live at time T (signed start at or before T, end date
    after T, posted at or before T) and made by the seeker's holder at T. They
    are published in genesis.json with their signed orders (orders.jsonl). */
function snapshotListings(orders, owners, T) {
  const out = new Map();
  for (const o of orders) {
    const p = o.parameters;
    if (!p || !Array.isArray(p.offer) || (o.status && o.status !== 'ACTIVE')) continue;
    const item = p.offer.find(x => String(x.token).toLowerCase() === CONFIG.nft);
    if (!item) continue;
    const id = Number(item.identifierOrCriteria), maker = String(p.offerer).toLowerCase();
    const s = Number(p.startTime), e = Number(p.endTime), t = o.created || s;
    if (!(id >= 1 && id <= CONFIG.supply) || owners[id - 1] !== maker || t > T || s > T || e <= T) continue;
    out.set(o.h, { h: o.h, id, maker, t, s, e });
  }
  return [...out.values()].sort((a, b) => a.id - b.id || (a.h < b.h ? -1 : 1));
}

/** Leave out relistings that cannot matter: of a seeker's listings that have
    ended, keep only enough to cover the same stretches of time (the rest
    overlap them completely). Then make sure, unit for unit, that every wallet
    comes out the same with and without the left-out ones; if not, keep all. */
function prune(genesis, chain, listings, until) {
  const full = Rules.replay(genesis, chain, listings, until);
  const byId = new Map();
  const keep = new Set();
  for (const l of listings) {
    const span = full.spans.get(l.h);
    if (!span) { if (l.e > until) keep.add(l.h); continue; }        // never live: matters only if it still can be
    if (span[1] === null || l.e > until) { keep.add(l.h); continue; }  // still live, or could still matter
    if (!byId.has(l.id)) byId.set(l.id, []);
    byId.get(l.id).push({ h: l.h, a: span[0], b: span[1] });
  }
  for (const spans of byId.values()) {                              // greedy cover of the same stretches of time
    spans.sort((x, y) => x.a - y.a || y.b - x.b);
    let i = 0;
    while (i < spans.length) {
      let reach = spans[i].b, best = spans[i];
      const startOfStretch = spans[i].a;
      keep.add(best.h);
      i++;
      for (;;) {
        let next = null;
        while (i < spans.length && spans[i].a <= reach) { if (!next || spans[i].b > next.b) next = spans[i]; i++; }
        if (!next || next.b <= reach) break;
        keep.add(next.h);
        reach = next.b;
      }
      void startOfStretch;
    }
  }
  const pruned = listings.filter(l => keep.has(l.h));
  if (pruned.length === listings.length) return listings;
  const lean = Rules.replay(genesis, chain, pruned, until);
  const numbers = s => [...s.accounts.values()].map(x => [x.address, x.units, x.earned, x.sent, x.received, x.held, x.unlisted].join()).sort().join('|');
  if (numbers(full) !== numbers(lean) || full.listedCount !== lean.listedCount) {
    console.log('  relistings: leaving them all in (the shorter record would not give exactly the same numbers)');
    return listings;
  }
  return pruned;
}

// ---------------------------------------------------------------- files

const file = name => path.join(DATA, name);
const readJson = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));
const readLines = name => fs.existsSync(file(name)) ? Rules.parseLines(fs.readFileSync(file(name), 'utf8')) : [];
const writeLines = (name, rows) => fs.writeFileSync(file(name), rows.map(r => JSON.stringify(r) + '\n').join(''));
const appendLines = (name, rows) => { if (rows.length) fs.appendFileSync(file(name), rows.map(r => JSON.stringify(r) + '\n').join('')); };
function writeJson(name, value) {
  fs.writeFileSync(file(name) + '.tmp', JSON.stringify(value) + '\n');
  fs.renameSync(file(name) + '.tmp', file(name));
}
function load() {
  const d = { genesis: readJson('genesis.json'), events: readLines('events.jsonl'), cancels: readLines('cancels.jsonl'),
              listings: readLines('listings.jsonl'), head: readJson('head.json') };
  d.play = until => Rules.replay(d.genesis, d.events.concat(d.cancels), d.listings, until ?? d.head.time);
  return d;
}
/** roughly the block of a moment, from the start and the last round */
function estimateBlock(genesis, head, time) {
  const rate = head.time > genesis.time ? (head.block - genesis.block) / (head.time - genesis.time) : 10;
  return genesis.block + Math.floor((time - genesis.time) * rate);
}

// ---------------------------------------------------------------- commands

/** The start (the round run with START=true): the block, who holds every
    seeker at it (from the chain), and the OpenSea listings live at it (read from
    OpenSea at that moment and published with their signed orders). */
async function start() {
  if (!/^(true|1)$/.test(process.env.START || '')) return console.log('the count has not started');
  const latest = await blockAt('latest');
  const block = await blockAt(latest.number - CONFIG.lag);
  const T = block.time;
  const orders = await currentOrders();                          // OpenSea's live listings, right now
  console.log(`start: block ${block.number} (${new Date(T * 1000).toISOString()}); OpenSea shows ${orders.length} active listings`);
  const owners = await ownersAt(block.number);
  const holders = [...new Set(owners)].sort();
  const index = new Map(holders.map((a, i) => [a, i]));
  const live = snapshotListings(orders, owners, T);
  const genesis = {
    version: 3, chainId: CONFIG.chainId, nft: CONFIG.nft, slug: CONFIG.slug, supply: CONFIG.supply,
    block: block.number, time: T, rules: CONFIG.rules,
    holders, owner: owners.map(a => index.get(a)),
    listings: live,
  };
  const atStart = new Set(live.map(l => l.h));
  const later = (await listingHistory(T, now())).filter(l => Rules.liveFrom(l) >= T && !atStart.has(l.h));
  Rules.replay(genesis, [], later, T);                           // throws if anything is inconsistent
  fs.mkdirSync(DATA, { recursive: true });
  writeJson('genesis.json', genesis);
  writeLines('events.jsonl', []);
  writeLines('cancels.jsonl', []);
  writeLines('listings.jsonl', later);
  const keep = new Set([...atStart, ...later.map(l => l.h)]);
  writeLines('orders.jsonl', orders.filter(o => keep.has(o.h)).map(({ h, protocol, parameters, signature }) => ({ h, protocol, parameters, signature })));
  writeJson('head.json', { block: block.number, time: T, listingsTime: now(), events: 0, cancels: 0, listings: later.length });
  console.log(`start: ${holders.length} addresses get ${CONFIG.rules.start} credits per seeker, capped at ${CONFIG.rules.startMax} per wallet; ` +
              `${new Set(live.map(l => l.id)).size} seekers start as listed (${live.length} live listings by their holders)`);
}

async function run() {
  if (!fs.existsSync(file('genesis.json'))) return start();
  const { genesis, events, cancels, listings, head } = load();
  const latest = await blockAt('latest');
  const block = await blockAt(latest.number - CONFIG.lag);
  if (block.number <= head.block) return console.log('nothing new');

  // OpenSea's listing history: the last day is read again each round, since it can fill in late
  let added = [], listingsTime = head.listingsTime, read = false;
  try {
    const known = new Set(listings.map(l => l.h));
    const seen = await listingHistory(Math.max(genesis.time, head.listingsTime - CONFIG.reread), now());
    added = seen.filter(l => !known.has(l.h) && Rules.liveFrom(l) >= genesis.time);
    listingsTime = now();
    read = true;
  } catch (e) {
    console.log(`OpenSea's listing history could not be read this round (${e.message}); the next round reads it again`);
  }
  const all = (genesis.listings || []).concat(listings, added);

  // the chain: the moves, and the Seaport logs of every lister's wallet
  const moves = await moveEvents(head.block + 1, block.number);
  const makers = new Set(all.map(l => l.maker));
  let seaport = makers.size ? await seaportLogs(head.block + 1, block.number, makers) : [];
  const late = added.filter(l => l.t < head.time);              // found late: look back for their cancellations too
  if (late.length) {
    const from = Math.max(genesis.block + 1, estimateBlock(genesis, head, Math.min(...late.map(l => l.t))) - 200000);
    seaport = seaport.concat(await seaportLogs(from, head.block, new Set(late.map(l => l.maker))));
  }
  const have = new Set(cancels.map(c => c.b + ':' + c.i));
  const freshCancels = (await cancelEvents(seaport, all)).filter(c => !have.has(c.b + ':' + c.i) && have.add(c.b + ':' + c.i));

  const chain = events.concat(moves, cancels, freshCancels);
  const kept = prune(genesis, chain, listings.concat(added), block.time);
  const after = Rules.replay(genesis, chain, kept, block.time);   // throws if anything is inconsistent
  appendLines('events.jsonl', moves);
  appendLines('cancels.jsonl', freshCancels);
  writeLines('listings.jsonl', kept);
  writeJson('head.json', { block: block.number, time: block.time, listingsTime,
                           events: events.length + moves.length, cancels: cancels.length + freshCancels.length,
                           listings: kept.length });
  console.log(`block ${block.number}: ${moves.length} moves, ${freshCancels.length} on-chain cancellations of listings, ` +
              `${added.length} new listings, ${listings.length + added.length - kept.length} overlapping relistings left out; ` +
              `${after.listedCount} seekers listed; ${Rules.credits(after.total, 0)} credits exist`);
}

async function check() {
  const latest = await blockAt('latest');
  console.log(`chain: block ${latest.number}, ${new Date(latest.time * 1000).toISOString()}`);
  const owners = await ownersAt(latest.number - CONFIG.lag);
  console.log(`chain: ${new Set(owners).size} holder addresses`);
  const hourAgo = await blockBefore(latest.time - 3600);
  const cancels = await seaportLogs(hourAgo.number, latest.number, null);
  const held = new Set(owners);
  console.log(`chain: ${cancels.length} Seaport cancellations in the last hour, ${cancels.filter(l => held.has(addr(l.topics[1]))).length} by seeker holders`);
  const r = await opensea(`/events/collection/${CONFIG.slug}?event_type=listing&limit=3&after=${now() - 86400}&before=${now()}`);
  console.log('opensea: a raw listing event, as OpenSea sends it:\n' + JSON.stringify((r.asset_events || [])[0] || r).slice(0, 1500));
  const week = await listingHistory(now() - 86400, now());
  console.log(`opensea: ${week.length} listings of seekers posted in the last day`);
  const T = now();
  const liveNow = week.filter(l => Rules.liveFrom(l) <= T && l.e > T && owners[l.id - 1] === l.maker);
  console.log(`opensea: of those, ${new Set(liveNow.map(l => l.id)).size} seekers have one that is before its end date and by the holder`);
  console.log(`opensea: for example ${liveNow.slice(0, 8).map(l => `#${l.id} (until ${new Date(l.e * 1000).toISOString().slice(0, 10)})`).join(' ')}`);
  const orders = await currentOrders();
  console.log(`opensea: ${orders.length} current listings with their signed orders; protocols ${[...new Set(orders.map(o => o.protocol))].join(', ')}`);
}

async function verify() {
  const { genesis, events, cancels, listings, head, play } = load();
  let ok = true;
  const say = (good, text) => { ok = ok && good; console.log((good ? 'ok    ' : 'WRONG ') + text); };
  const same = (a, b, key) => a.length === b.length && a.every((x, i) => key(x) === key(b[i]));

  const owners = await ownersAt(genesis.block);
  say(owners.every((a, i) => genesis.holders[genesis.owner[i]] === a), `the ${genesis.holders.length} holders at the start (block ${genesis.block}) are the chain's`);
  say((await blockAt(genesis.block)).time === genesis.time, `the start time is that block's time`);

  const moves = await moveEvents(genesis.block + 1, head.block);
  const mine = events.filter(e => e.k === 'move');
  say(same(mine, moves, e => JSON.stringify([e.t, e.b, e.i, e.id, e.from, e.to, e.tx])),
      `the ${mine.length} moves on record are exactly the chain's Transfer events (${moves.length}), in order, up to block ${head.block}`);
  const fixes = events.filter(e => e.k === 'adjust');
  if (fixes.length) console.log(`note  ${fixes.length} corrections made by hand, each with its reason`);

  const start = genesis.listings || [];
  const archived = new Map(readLines('orders.jsonl').map(o => [o.h, o]));
  say(start.every(l => owners[l.id - 1] === l.maker && Rules.liveFrom(l) <= genesis.time && l.e > genesis.time),
      `the ${start.length} listings live at the start were each made by the seeker's holder at the start, posted before it and ending after it`);
  say(start.every(l => { const o = archived.get(l.h); return o && String(o.parameters.offerer).toLowerCase() === l.maker && Number(o.parameters.endTime) === l.e; }),
      `each of them is published with its signed order (data/orders.jsonl)`);
  let all = start.concat(listings), history = null;
  try { history = await listingHistory(genesis.time, now()); } catch (e) { console.log(`skip  OpenSea's listing history could not be read (${e.message}): checking the listings on record only`); }
  if (history) {
    const settled = head.listingsTime - CONFIG.settle, atStart = new Set(start.map(l => l.h));
    const fromHistory = history.filter(l => Rules.liveFrom(l) >= genesis.time && l.t <= settled && !atStart.has(l.h));
    const known = new Map(fromHistory.map(l => [l.h, JSON.stringify([l.id, l.maker, l.t, l.s, l.e])]));
    const strange = listings.filter(l => l.t <= settled && known.get(l.h) !== JSON.stringify([l.id, l.maker, l.t, l.s, l.e]));
    say(!strange.length, `every listing on record (${listings.length}) is in OpenSea's history exactly as recorded` + (strange.length ? `: ${strange.length} are not` : ''));
    all = start.concat(fromHistory, listings.filter(l => l.t > settled && !known.has(l.h)));
  }
  // the on-chain cancellations, re-read from the chain for every listing (recorded or not)
  const makers = new Set(all.map(l => l.maker));
  const chainCancels = makers.size ? await cancelEvents(await seaportLogs(genesis.block + 1, head.block, makers), all) : [];
  const ck = c => JSON.stringify([c.k, c.t, c.b, c.i, c.h, c.a, c.tx]);
  const real = new Set(chainCancels.map(ck));
  say(cancels.every(c => real.has(ck(c))), `the ${cancels.length} on-chain cancellations on record are all real (the chain has ${chainCancels.length} for these listings)`);
  if (history) {
    // end to end: everything rebuilt from the chain and OpenSea's full history, against the record
    const rebuilt = Rules.replay(genesis, moves.concat(fixes, chainCancels), all.filter(l => !(genesis.listings || []).some(x => x.h === l.h)), head.time);
    const recordOnly = play();
    const numbers = x => [...x.accounts.values()].map(y => [y.address, y.units].join()).sort().join('|');
    say(numbers(rebuilt) === numbers(recordOnly), `every wallet's balance rebuilt from the chain and OpenSea's full history equals the record's, to the unit` +
        ` (${all.length - start.length} listings since the start in the history; the record keeps ${listings.length}, leaving out overlapping relistings)`);
  }
  try {
    const s = play();
    let made = 0, started = 0;
    for (const x of s.accounts.values()) { made += x.earned + x.adjusted; started += x.start; }
    say(s.total === started + made, `the balances add up: ${Rules.credits(s.total)} credits = ` +
        `${Rules.credits(started, 0)} at the start + ${Rules.credits(made)} earned by holding`);
  } catch (e) { say(false, e.message); }
  if (!ok) process.exit(1);
}

function balance(address) {
  const { genesis, play } = load();
  const s = play();
  const x = s.accounts.get(String(address).toLowerCase());
  if (!x) return console.log('that address has never held a seeker since the start');
  const mine = Rules.seekersOf(s, x.address);
  console.log(`${x.address} at ${new Date(s.time * 1000).toISOString()}`);
  const c = Rules.credits;
  console.log(`  balance ${c(x.units)} credits, earning ${x.unlisted * genesis.rules.perDay} a day`);
  console.log(`  seekers ${mine.map(m => '#' + m.id + (m.listed ? ' (listed)' : '')).join(', ') || 'none'}`);
  console.log(`  start ${c(x.start)} + earned ${c(x.earned)} + received ${c(x.received)} - sent ${c(x.sent)}` +
              (x.adjusted ? ` + corrections ${c(x.adjusted)}` : ''));
  for (const h of x.history) {
    console.log(`  ${new Date(h.t * 1000).toISOString().slice(0, 16)}  ${h.k.padEnd(6)} ${h.id ? '#' + h.id : ''} ` +
                `${h.d ? (h.d > 0 ? '+' : '') + c(h.d) : ''} ${h.who || h.why || h.note || ''}`);
  }
}

function totals() {
  const { head, play } = load();
  const s = play();
  const all = [...s.accounts.values()].filter(x => x.held || x.units).sort((a, b) => b.units - a.units);
  console.log(`${new Date(s.time * 1000).toISOString()}  block ${head.block}`);
  console.log(`${Rules.credits(s.total)} credits on ${all.length} addresses; ${s.listedCount} of ${s.supply} seekers listed`);
  for (const x of all.slice(0, 15)) console.log(`  ${x.address}  ${Rules.credits(x.units).padStart(10)}  ${x.held} seekers, ${x.held - x.unlisted} listed`);
}

/** Ready-made results for the page, so a check loads one small file: everything
    in them is worked out from the records by rules.js, and the records are
    published next to them for anyone who wants to redo it. */
function publish(dir) {
  if (!dir) throw new Error('usage: node bot/bot.js publish DIR');
  if (!fs.existsSync(file('genesis.json'))) return console.log('no start yet: nothing to publish');
  const { genesis, listings, head, play } = load();
  const s = play();
  const orders = new Map(readLines('orders.jsonl').map(o => [o.h, o]));
  const out = path.join(dir, 'data', 'wallets');
  fs.mkdirSync(out, { recursive: true });
  const byMaker = new Map();
  for (const l of (genesis.listings || []).concat(listings)) {
    if (l.e <= s.time || s.owner[l.id] !== l.maker) continue;
    if (!byMaker.has(l.maker)) byMaker.set(l.maker, []);
    byMaker.get(l.maker).push(l);
  }
  let holders = 0, startTotal = 0, n = 0;
  for (const x of s.accounts.values()) {
    if (x.held) holders++;
    startTotal += x.start;
    const mine = Rules.seekersOf(s, x.address);
    fs.writeFileSync(path.join(out, x.address + '.json'), JSON.stringify({
      address: x.address, time: s.time, units: x.units, unlisted: x.unlisted, held: x.held,
      start: x.start, earned: x.earned, received: x.received, sent: x.sent, adjusted: x.adjusted,
      seekers: mine.map(m => [m.id, m.listed ? 1 : 0]), history: x.history,
      listings: (byMaker.get(x.address) || []).map(l => ({ h: l.h, id: l.id, e: l.e, order: (orders.get(l.h) || {}).parameters || null })),
    }));
    n++;
  }
  fs.writeFileSync(path.join(dir, 'data', 'summary.json'), JSON.stringify({
    time: s.time, block: head.block, listingsTime: head.listingsTime, nft: genesis.nft, rules: genesis.rules,
    start: { block: genesis.block, time: genesis.time, wallets: genesis.holders.length, units: startTotal, listed: new Set((genesis.listings || []).map(l => l.id)).size },
    totals: { units: s.total, holders, earning: s.supply - s.listedCount, listed: s.listedCount, supply: s.supply },
  }));
  console.log(`published ${n} wallets and the summary at block ${head.block}`);
}

module.exports = { CONFIG, TOPIC, blockAt, blockBefore, ownersAt, moveEvents, cancelEvents, listingFromEvent, seconds, snapshotListings, prune };

if (require.main === module) {
  const [command, argument] = process.argv.slice(2);
  const commands = { check, run, verify, balance: () => balance(argument), totals, publish: () => publish(argument) };
  if (!commands[command]) {
    console.log('usage: node bot/bot.js check | run | verify | balance 0xADDRESS | totals | publish DIR');
    process.exit(1);
  }
  Promise.resolve(commands[command]()).catch(e => { console.error(e.message || e); process.exit(1); });
}
