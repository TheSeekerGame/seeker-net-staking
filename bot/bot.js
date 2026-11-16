#!/usr/bin/env node
/* SEEKER NET credits: the bot.

   node bot/bot.js check               read-only: can the bot read the chain and OpenSea right now? writes nothing
   node bot/bot.js run                 one round: copy the new public records into data/
   node bot/bot.js verify              rebuild data/ from the chain and OpenSea's history and compare
   node bot/bot.js balance 0xADDRESS   an address's balance and history
   node bot/bot.js totals              the whole picture in a few numbers

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
  startBack: 600,     // the start is the block this many seconds before the starting round (OpenSea's history needs a moment)
  settle: 3600,       // OpenSea's history can take a while to fill in: verify only compares listings older than this,
  reread: 86400,      // and every round re-reads this much of OpenSea's listing history
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
async function logs(filter, from, to) {
  const out = [];
  let span = 5000000;
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
      out.push(...await logs({ address, topics: [[TOPIC.cancel, TOPIC.counter], who] }, from, to));
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
  const out = new Map();
  let next = null;
  for (let page = 0; page < 5000; page++) {
    const q = `/events/collection/${CONFIG.slug}?event_type=listing&limit=200&after=${after}&before=${before}` +
              (next ? '&next=' + encodeURIComponent(next) : '');
    const r = await opensea(q);
    if (!Array.isArray(r.asset_events)) throw new Error('OpenSea sent no list of events');
    for (const ev of r.asset_events) {
      const l = listingFromEvent(ev);
      if (l) out.set(l.h, l);
    }
    next = r.next;
    if (!next) return [...out.values()].sort((a, b) => a.t - b.t || (a.h < b.h ? -1 : 1));
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
                                                      parameters: l.protocol_data.parameters, signature: l.protocol_data.signature });
    }
    next = r.next;
    if (!next) return out;
  }
  return out;
}

// ---------------------------------------------------------------- the start

/** The listings live at the start (time T, block `block`), as rules.js has it:
    live before T, end date after T, by the seeker's holder at T who has held it
    since before it went live, and not cancelled on-chain before T. */
async function liveAtStart(history, owners, block, T) {
  const lastMoveTime = await blockTimes(owners.lastMove);
  const candidates = history.filter(l => Rules.liveFrom(l) < T && l.e > T &&
    owners[l.id - 1] === l.maker && lastMoveTime.get(owners.lastMove[l.id - 1]) <= Rules.liveFrom(l));
  const makers = new Set(candidates.map(l => l.maker));
  const cancels = makers.size ? await seaportLogs(CONFIG.firstBlock, block, makers) : [];
  const times = await blockTimes(cancels.filter(l => l.topics[0] === TOPIC.counter).map(l => l.blockNumber));
  const cancelled = new Set(cancels.filter(l => l.topics[0] === TOPIC.cancel).map(l => l.data.slice(0, 66).toLowerCase()));
  const lastCounter = new Map();
  for (const l of cancels) if (l.topics[0] === TOPIC.counter) lastCounter.set(addr(l.topics[1]), times.get(Number(l.blockNumber)));
  return candidates.filter(l => !cancelled.has(l.h) && !(l.t < (lastCounter.get(l.maker) ?? -Infinity)))
    .map(({ h, id, maker, t, s, e, p }) => ({ h, id, maker, t, s, e, ...(p ? { p } : {}) }));
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

/** The start. Its block is fixed first (data/start.json), by the round run with
    START=true; the rest (who held what, the listings live at that block) follows
    from public records, so it can be worked out then or later with the same result. */
async function start() {
  fs.mkdirSync(DATA, { recursive: true });
  let at = fs.existsSync(file('start.json')) ? readJson('start.json') : null;
  if (!at) {
    if (!/^(true|1)$/.test(process.env.START || '')) return console.log('the count has not started');
    const block = await blockBefore(now() - CONFIG.startBack);
    at = { block: block.number, time: block.time };
    writeJson('start.json', at);
    console.log(`staking starts at block ${at.block} (${new Date(at.time * 1000).toISOString()})`);
  }
  let history;
  try {
    history = await listingHistory(0, now());
  } catch (e) {
    return console.log(`the start is fixed at block ${at.block}; the rest waits for OpenSea's listing history (${e.message})`);
  }
  const owners = await ownersAt(at.block);
  const holders = [...new Set(owners)].sort();
  const index = new Map(holders.map((a, i) => [a, i]));
  const genesis = {
    version: 2, chainId: CONFIG.chainId, nft: CONFIG.nft, slug: CONFIG.slug, supply: CONFIG.supply,
    block: at.block, time: at.time, rules: CONFIG.rules,
    holders, owner: owners.map(a => index.get(a)),
    listings: await liveAtStart(history, owners, at.block, at.time),
  };
  const later = history.filter(l => Rules.liveFrom(l) >= at.time);
  Rules.replay(genesis, [], later, at.time);                    // throws if anything is inconsistent
  writeJson('genesis.json', genesis);
  writeLines('events.jsonl', []);
  writeLines('cancels.jsonl', []);
  writeLines('listings.jsonl', later);
  writeJson('head.json', { block: at.block, time: at.time, listingsTime: now(), events: 0, cancels: 0, listings: later.length });
  console.log(`start (block ${at.block}): ${holders.length} addresses get ${CONFIG.rules.start} credits per seeker, capped at ${CONFIG.rules.startMax} per wallet; ` +
              `${new Set(genesis.listings.map(l => l.id)).size} seekers listed at the start; ${later.length} listings since. The next round catches up to now.`);
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

  const after = Rules.replay(genesis, events.concat(moves, cancels, freshCancels), listings.concat(added), block.time);   // throws if anything is inconsistent
  appendLines('events.jsonl', moves);
  appendLines('cancels.jsonl', freshCancels);
  appendLines('listings.jsonl', added);
  if (read) {
    try {                                                       // the archive of signed orders: nice to have
      const archived = new Set(readLines('orders.jsonl').map(o => o.h));
      const hashes = new Set(all.map(l => l.h));
      appendLines('orders.jsonl', (await currentOrders()).filter(o => hashes.has(o.h) && !archived.has(o.h)));
    } catch (e) { console.log(`the signed orders could not be archived this round (${e.message})`); }
  }
  writeJson('head.json', { block: block.number, time: block.time, listingsTime,
                           events: events.length + moves.length, cancels: cancels.length + freshCancels.length,
                           listings: listings.length + added.length });
  console.log(`block ${block.number}: ${moves.length} moves, ${freshCancels.length} on-chain cancellations of listings, ` +
              `${added.length} new listings; ${after.listedCount} seekers listed; ${Rules.credits(after.total, 0)} credits exist`);
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
  const r = await opensea(`/events/collection/${CONFIG.slug}?event_type=listing&limit=3&after=${now() - 7 * 86400}&before=${now()}`);
  console.log('opensea: a raw listing event, as OpenSea sends it:\n' + JSON.stringify((r.asset_events || [])[0] || r).slice(0, 1500));
  const week = await listingHistory(now() - 7 * 86400, now());
  console.log(`opensea: ${week.length} listings of seekers posted in the last 7 days`);
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

  let all = (genesis.listings || []).concat(listings), history = null;
  try { history = await listingHistory(0, now()); } catch (e) { console.log(`skip  OpenSea's listing history could not be read (${e.message}): checking the listings on record only`); }
  if (history) {
    const start = await liveAtStart(history, owners, genesis.block, genesis.time);
    const k = l => JSON.stringify([l.h, l.id, l.maker, l.t, l.s, l.e]);
    const a = new Set(start.map(k)), b = new Set((genesis.listings || []).map(k));
    say(a.size === b.size && [...a].every(x => b.has(x)), `the ${b.size} listings live at the start are what OpenSea's history and the chain give (${a.size})`);
    const settled = head.listingsTime - CONFIG.settle;
    const want = new Map(history.filter(l => Rules.liveFrom(l) >= genesis.time && l.t <= settled).map(l => [l.h, k(l)]));
    const have = new Map(listings.filter(l => l.t <= settled).map(l => [l.h, k(l)]));
    const missing = [...want.keys()].filter(h => !have.has(h)), extra = [...have.keys()].filter(h => !want.has(h));
    const changed = [...want.keys()].filter(h => have.has(h) && have.get(h) !== want.get(h));
    say(!missing.length && !extra.length && !changed.length,
        `the ${have.size} listings on record (posted until an hour before the last read) are OpenSea's history` +
        (missing.length + extra.length + changed.length ? `: ${missing.length} missing, ${extra.length} extra, ${changed.length} different` : ''));
    all = start.concat(history.filter(l => Rules.liveFrom(l) >= genesis.time && l.t <= head.listingsTime));
  }
  const makers = new Set(all.map(l => l.maker));
  const chainCancels = makers.size ? await cancelEvents(await seaportLogs(genesis.block + 1, head.block, makers), all) : [];
  const ck = c => JSON.stringify([c.k, c.t, c.b, c.i, c.h, c.a, c.tx]);
  const recorded = [...cancels].sort((a, b) => a.b - b.b || a.i - b.i);
  say(same(recorded, chainCancels, ck), `the ${cancels.length} on-chain cancellations on record are exactly the chain's (${chainCancels.length}) for those listings`);
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

module.exports = { CONFIG, TOPIC, blockAt, blockBefore, ownersAt, moveEvents, cancelEvents, listingFromEvent, seconds, liveAtStart };

if (require.main === module) {
  const [command, argument] = process.argv.slice(2);
  const commands = { check, run, verify, balance: () => balance(argument), totals };
  if (!commands[command]) {
    console.log('usage: node bot/bot.js check | run | verify | balance 0xADDRESS | totals');
    process.exit(1);
  }
  Promise.resolve(commands[command]()).catch(e => { console.error(e.message || e); process.exit(1); });
}
