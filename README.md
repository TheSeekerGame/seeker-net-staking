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
| `data/genesis.json` | the start: its block and time, the rules' numbers, who held every seeker (from the chain), and the OpenSea listings live at that moment (read from OpenSea then; their orders, as OpenSea served them, are in `data/orders.jsonl`) |
| `data/events.jsonl` | every move of a seeker since the start (the chain's Transfer events, in chain order), plus any correction made by hand |
| `data/cancels.jsonl` | the on-chain cancellations that can end a seeker listing (Seaport's `OrderCancelled` and `CounterIncremented`) |
| `data/listings.jsonl` | the OpenSea listings of seekers since the start, from OpenSea's listing history. Relistings that overlap another listing of the same seeker are left out once they end, since they change no balance (the bot only leaves them out after checking every wallet's numbers come out the same) |
| `data/orders.jsonl` | the orders behind the listings live at the start, as OpenSea served them (without signatures; an archive, the rules never read it) |
| `data/head.json` | how far the copy goes |
| `data/summary.json`, `data/wallets/` | ready-made results for the page, one small file per wallet: worked out from the records above when the site is published (not kept in the repository) |
| `rules.js` | the rules: turns the files above into every balance. Used by the bot and by the page |
| `og.png`, `icon.png` | the picture shown when the link is shared, and the tab icon (seeker #1302, from the collection's layers) |
| `index.html` | the page: type an address, see its balance, what it earns, which seekers count as listed and until when, and its history |
| `bot/bot.js` | the bot. Runs every 5 minutes (`.github/workflows/credits.yml`, started by `.github/workflows/timer.yml`) and only copies records |
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

Only an on-chain cancellation ends a listing early. OpenSea's normal cancel on
Robinhood Chain is one (you approve a small transaction); a cancel that doesn't
go on-chain leaves no record of when it happened, so it can't count. A listing
otherwise counts until its end date, whenever its lister holds the seeker: it pauses
while the seeker is in another wallet and counts again if it comes back. The exact rules are at the
top of `rules.js` and, in plain words, on the page.

## Check it yourself

Needs Node 18 or newer, and an OpenSea API key for `verify` (in `OPENSEA_API_KEY`); without one, `verify` fails, since it can't check the listings.

```
node bot/bot.js verify             # rebuilds every record from the chain and OpenSea's history and compares
node bot/bot.js balance 0xADDRESS  # one address: balance, seekers, history
node bot/bot.js totals             # the whole picture
```

`verify` rebuilds the holders at the start from every Transfer since the
contract began, the moves and on-chain cancellations from the chain, and the
listings since the start from OpenSea's listing history, and checks the records
against them. Then it rebuilds every balance from the chain and OpenSea's full
history and checks it equals the record's, to the unit.

The one thing it can't rebuild is the listings live at the start: they were read
from OpenSea once, at the start, and are published as read. `verify` only checks
that each was by the seeker's holder, live at the start, and matches its
published order. OpenSea's history can take a while to fill in, so listings from
the last few hours may still be added (and once a day the bot re-reads the last
day and a half).

## Running the bot

`node bot/bot.js run` does one round. The first round ever makes
`data/genesis.json`: the start, at the newest block (30 blocks, a few seconds,
behind the chain's tip), with a snapshot of the listings OpenSea showed as live
then. On GitHub, the count only starts when the
workflow is run by hand with "start" ticked; until then every round only runs
the read-only `check`. The bot needs an OpenSea API
key: set `OPENSEA_API_KEY` (in GitHub: a repository secret of that name), or
leave it unset and the bot takes one of OpenSea's free 7-day keys and renews it
itself.

SEEKER NET: `0x5aC790269A6c71a51Ba68BF6a3a2647F86788792` on Robinhood Chain (4663).
