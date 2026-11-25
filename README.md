# Pump.fun Bot Sprint: Make Bot And Win

[![bounty](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Nadanese93/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Nadanese93/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for pump.fun bonding curves (pumpfun-replay/v2).
It buys the bounce after a dip and exits fast — no clock, no randomness, no
network, no environment reads.

## Strategy

Per mint, price = `virtual_quote_reserves / virtual_token_reserves`, tracked with
a fast EMA (alpha 0.20) and a slow EMA (alpha 0.05). It enters only when the fast
EMA is at least 8.5% below the slow EMA, the price itself is at least 5% below the
slow EMA (but no more than 20% below it), **and** the price has turned back up to
at least the fast EMA — that bounce confirmation is what separates a recovering
dip from a coin still falling. Entries need at least 8 trades and 2 SOL of
cumulative volume on the mint.

Size is a fixed 0.25 SOL, sent only when the harness size cap (1% of real SOL
reserve) allows the full 0.25 SOL. That cap acts as a liquidity filter: only
the deeper, more liquid curves are traded, which an offline sweep showed is
where the dip-buy edge actually lives. Exits: take-profit +60%, stop-loss −6%,
trailing give-back −4% from a peak of +8% or more, fast EMA back above slow EMA,
or max hold 2000 slots. The EMA and trailing exits are gated by a 500-slot
minimum hold — the bounce needs room to develop, and exiting on the first EMA
flicker just pays fees. After any exit the same mint is left alone for 10000
slots — a cooldown that kills churn re-entries into a still-falling curve, the
biggest leak in the naive dip-buy variant. At most 5 open positions.

## Dev-window results (grade-local, kit dev dataset)

The naive dip-buy variant this iterates on lost −0.378 SOL on dev (37.9% win
rate, 124 round trips, fees ~0.8 SOL). This variant, graded with
`makefun grade-local --driver process`: **+0.786 SOL net PnL, 37 round trips,
31 distinct mints, 40.5% win rate, 1.95% max drawdown, Sharpe 0.32, 0.241 SOL
curve fees + 0.008 SOL tx fees**. The 90% bootstrap interval is wide
(−0.004 to +1.678 SOL): the edge comes from a few large winners, so the final
6h window — fresh data nobody can tune against — is a genuine coin flip on
magnitude, not a guarantee. Momentum-breakout and early-sniper variants were
also swept and were far worse (both deeply negative), so the dip-bounce family
was kept. Two independent lessons from the sweep: (1) a unit bug in the first
version compared entry prices in SOL/token against exit prices in
lamports/token, which made every position "hit take-profit" instantly — fixed
by keeping both in lamports/token; (2) exits must wait — a 500-slot minimum
hold before EMA/trailing exits roughly tripled dev net PnL versus exiting on
the first EMA flicker.

## Run

The grader runs `node /bot/main.ts`. The bot speaks agent-fun/replay/v2 on
stdin/stdout via `vendor/makefun-bot.ts` (a byte-identical copy of the kit SDK).
