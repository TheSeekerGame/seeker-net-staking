# SEEKER NET staking

- 🪙 every unlisted seeker earns 1 credit per day
- 🗳️ credits accumulate on your address (not tradable)
- 🔀 selling / moving transfers 7 credits to new owner
- 🔥 spend credits on rare traits in THE FORGE (coming soon)

This repository is the whole system: the record, the rules, the bot that keeps
the record, and the page that shows balances.

**Fully deterministic.** Every balance follows from permanent public records
only: the chain and OpenSea's listing history. Nothing depends on when the bot
looks or how often it runs, so anyone who replays the same records gets exactly
the same balance for every wallet, to the unit.

| | |
|---|---|
| `data/genesis.json` | the start: its block and time, the rules' numbers, who held every seeker, and the OpenSea listings live at that moment |
| `data/events.jsonl` | every move of a seeker since the start (the chain's Transfer events, in chain order), plus any correction made by hand |
| `data/cancels.jsonl` | the on-chain cancellations that can end a seeker listing (Seaport's `OrderCancelled` and `CounterIncremented`) |
| `data/listings.jsonl` | every OpenSea listing of a seeker since the start, from OpenSea's listing history |
| `data/orders.jsonl` | the signed orders behind those listings, where OpenSea still served them (an archive; the rules never read it) |
| `data/head.json` | how far the copy goes |
| `data/summary.json`, `data/wallets/` | ready-made results for the page, one small file per wallet: worked out from the records above when the site is published (not kept in the repository) |
| `rules.js` | the rules: turns the files above into every balance. Used by the bot and by the page |
| `og.png`, `icon.png` | the picture shown when the link is shared, and the tab icon (seeker #1302, from the collection's layers) |
| `index.html` | the page: type an address, see its balance, what it earns and its history; end your listings on-chain |
| `bot/bot.js` | the bot. Runs a few times an hour (`.github/workflows/credits.yml`) and only copies records |
| `bot/test.js` | tests of the rules: `node --test bot/test.js` |

Balances are stored nowhere. They are worked out from the records every time, in
whole numbers (1 credit = 86,400 units, one per seeker per second).

## The records

```
{"k":"move","t":1794573255,"b":113357302,"i":35,"id":622,"from":"0x…","to":"0x…","tx":"0x…"}
{"k":"cancel","t":1794600000,"b":113600000,"i":4,"h":"0x…order hash","a":"0x…lister","tx":"0x…"}
{"k":"counter","t":1794600000,"b":113600000,"i":4,"a":"0x…lister","tx":"0x…"}
{"h":"0x…order hash","id":295,"maker":"0x…","t":1794600000,"s":1794600000,"e":1797192000}
```

- `move`: a seeker changed wallet: the chain's Transfer event at block `b`,
  position `i`, time `t` (the block's), transaction `tx`.
- `cancel` / `counter`: Seaport's `OrderCancelled` for a recorded listing, or
  `CounterIncremented` by a lister (it ends all the listings they posted before it).
- a listing: order hash `h`, seeker `id`, lister `maker`, posted at `t`, signed
  start `s` and end date `e`, as OpenSea's listing history has them.
- `adjust`: a correction made by hand, with `a` (address), `credits` and a
  `note` saying why.

OpenSea's free cancel happens off the chain and OpenSea keeps no record of when,
so it does not end a listing: a listing counts until its end date unless the
seeker moves or the listing is cancelled on-chain. The exact rules are at the
top of `rules.js` and, in plain words, on the page.

## Check it yourself

Needs Node 18 or newer, nothing else.

```
node bot/bot.js verify             # rebuilds every record from the chain and OpenSea's history and compares
node bot/bot.js balance 0xADDRESS  # one address: balance, seekers, history
node bot/bot.js totals             # the whole picture
```

`verify` rebuilds the holders at the start from every Transfer since the
contract began, the listings live at the start and every listing since from
OpenSea's listing history, and the moves and on-chain cancellations from the
chain, and checks that the records are exactly these. OpenSea's history can take
a while to fill in, so listings from the last hour may still be added; older
ones are final.

## Running the bot

`node bot/bot.js run` does one round. The first round ever makes
`data/genesis.json`: the start, at a block an hour in the past (so OpenSea's
history up to it has settled). On GitHub, the count only starts when the
workflow is run by hand with "start" ticked; until then every round only runs
the read-only `check`. The bot needs an OpenSea API
key: set `OPENSEA_API_KEY` (in GitHub: a repository secret of that name), or
leave it unset and the bot takes one of OpenSea's free 7-day keys and renews it
itself.

SEEKER NET: `0x5aC790269A6c71a51Ba68BF6a3a2647F86788792` on Robinhood Chain (4663).
