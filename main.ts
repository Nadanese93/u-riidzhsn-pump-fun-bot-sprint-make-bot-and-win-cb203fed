// Pump.fun dip-bounce bot (pumpfun-replay/v2).
//
// Strategy (chosen by offline sweep over the kit dev window; see README):
// per-mint price = virtual_quote_reserves / virtual_token_reserves, tracked with a
// fast EMA (alpha 0.20) and a slow EMA (alpha 0.05). Buy the bounce: enter only when
// the fast EMA is >= 8.5% below the slow EMA, the price itself is >= 5% below the
// slow EMA but still >= 80% of it, AND the price has turned back up to at least the
// fast EMA (bounce confirmation). Entries need >= 8 trades and >= 2 SOL of
// cumulative volume on the mint. Size is a fixed 0.25 SOL, sent only when the
// harness size cap (1% of real SOL reserve) allows the full 0.25 SOL, which acts
// as a liquidity filter: only the deeper, more liquid curves are traded.
// Exits: take-profit +60%, stop-loss -6%, trailing give-back -4% from a peak of
// >= +8%, fast EMA back above slow EMA, or max hold 2000 slots. The EMA and
// trailing exits are gated by a 500-slot minimum hold: the bounce needs room to
// develop, and exiting on the first EMA flicker just pays fees. After any exit,
// the same mint is left alone for 10000 slots — a cooldown that kills churn
// re-entries into a still-falling curve, the biggest leak in the naive dip-buy
// variant. At most 5 open positions. Fully deterministic: no clock, no randomness, no
// environment reads; every iteration order that affects output is sorted or
// follows the harness event order.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// --- tuned parameters (offline sweep on the dev window) ---
const SIZE_LAMPORTS = 250_000_000n; // 0.25 SOL per entry
const FAST_ALPHA = 0.2;
const SLOW_ALPHA = 0.05;
const DIP_FAST = 0.085; // fast EMA must be >= 8.5% below slow EMA
const DIP_PRICE = 0.05; // price must be >= 5% below slow EMA
const DIP_FLOOR = 0.2; // ... but no more than 20% below slow EMA
const MIN_TRADES = 8;
const MIN_VOL_SOL = 2;
const TAKE_PROFIT = 0.6;
const STOP_LOSS = 0.06;
const TRAIL_TRIGGER = 0.08;
const TRAIL_GIVEBACK = 0.04;
const MAX_HOLD_SLOTS = 2000;
const MIN_HOLD_SLOTS = 500; // no EMA/trailing exit before this long after entry:
  // the bounce needs room to develop; exiting on the first EMA flicker just
  // pays fees (the naive variant's exits fired within ~2 slots of entry).
const COOLDOWN_SLOTS = 10000;
const MAX_SLIPPAGE_BPS = 500;
const MAX_BUYS_PER_BATCH = 5;

interface MintTrack {
  fast: number;
  slow: number;
  trades: number;
  volSol: number;
  complete: boolean;
  lastExitSlot: number;
}

interface Held {
  entry: number; // cost basis per token (SOL), from the buy fill
  peak: number;
  entrySlot: number;
}

const tracks = new Map<string, MintTrack>();
const held = new Map<string, Held>();

function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves <= 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function trackFor(mint: string, price: number): MintTrack {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { fast: price, slow: price, trades: 0, volSol: 0, complete: false, lastExitSlot: -1e15 };
    tracks.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state, batch: Batch) {
    // 1. Fold fills in: record entries, clear exited positions, arm cooldowns.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const tokens = Number(BigInt(f.token_amount));
        const quote = Number(BigInt(f.quote_lamports));
        if (tokens > 0 && quote > 0) {
          // Entry in lamports per token — the same units priceOf() returns.
          const entry = quote / tokens;
          held.set(f.mint, { entry, peak: entry, entrySlot: f.slot });
        }
      } else {
        held.delete(f.mint);
        const t = tracks.get(f.mint);
        if (t !== undefined) t.lastExitSlot = f.slot;
        else tracks.set(f.mint, { fast: 0, slow: 0, trades: 0, volSol: 0, complete: false, lastExitSlot: f.slot });
      }
    }

    // 2. Update per-mint EMA/volume state from this batch's events, in order.
    for (const e of batch.events) {
      if (e.event === 'CompleteEvent') {
        const t = tracks.get(e.mint);
        if (t !== undefined) t.complete = true;
        continue;
      }
      const price = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = trackFor(e.mint, price);
      if (e.event === 'CreateEvent') continue;
      // TradeEvent
      t.trades += 1;
      t.volSol += Number(BigInt(e.sol_amount)) / 1e9;
      if (t.trades === 1) {
        t.fast = price;
        t.slow = price;
      } else {
        t.fast += FAST_ALPHA * (price - t.fast);
        t.slow += SLOW_ALPHA * (price - t.slow);
      }
    }

    const orders: OrderInput[] = [];

    // 3. Exits first, mints in sorted order (deterministic).
    const selling = new Set<string>();
    const pendingSellMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
    }
    const heldMints = [...state.positions.keys()].sort();
    for (const mint of heldMints) {
      if (pendingSellMints.has(mint)) continue; // a sell is already in flight
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const price = priceOf(state, mint);
      if (price === null) continue;
      let h = held.get(mint);
      if (h === undefined) {
        // Defensive: position without a recorded fill (should not happen).
        const tokens = Number(pos.token_amount);
        const cost = Number(pos.cost_lamports);
        if (tokens <= 0 || cost <= 0) continue;
        h = { entry: cost / tokens, peak: cost / tokens, entrySlot: batch.slot };
        held.set(mint, h);
      }
      if (price > h.peak) h.peak = price;
      const ret = price / h.entry - 1;
      const t = tracks.get(mint);
      const emaCrossed = t !== undefined && t.trades > 0 && t.fast >= t.slow;
      const aged = batch.slot - h.entrySlot >= MIN_HOLD_SLOTS;
      const exit =
        ret >= TAKE_PROFIT ||
        ret <= -STOP_LOSS ||
        (aged && h.peak / h.entry - 1 >= TRAIL_TRIGGER && price / h.peak - 1 <= -TRAIL_GIVEBACK) ||
        (aged && emaCrossed) ||
        batch.slot - h.entrySlot >= MAX_HOLD_SLOTS;
      if (exit) {
        selling.add(mint);
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    // 4. Entries, in harness event order. One buy per mint, at most 5 per batch.
    let buys = 0;
    const pendingBuyMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
    }
    for (const e of batch.events) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (selling.has(mint)) continue;
      if (state.positions.has(mint) || pendingBuyMints.has(mint)) continue;
      const t = tracks.get(mint);
      if (t === undefined || t.complete) continue;
      if (t.trades < MIN_TRADES || t.volSol < MIN_VOL_SOL) continue;
      if (batch.slot - t.lastExitSlot < COOLDOWN_SLOTS) continue;
      if (state.committedPositionCount() + buys >= state.hello.caps.max_open_positions) continue;
      const price = Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
      if (!Number.isFinite(price) || price <= 0 || t.slow <= 0) continue;
      if (t.fast > t.slow * (1 - DIP_FAST)) continue;
      if (price > t.slow * (1 - DIP_PRICE)) continue;
      if (price < t.slow * (1 - DIP_FLOOR)) continue;
      if (price < t.fast) continue; // bounce confirmation: price back above fast EMA
      if (state.maxBuyLamports(mint) < SIZE_LAMPORTS) continue; // liquidity filter
      if (state.freeCashLamports() < SIZE_LAMPORTS + state.txFeeLamports()) continue;
      orders.push({ side: 'buy', mint, quote_lamports: SIZE_LAMPORTS, max_slippage_bps: MAX_SLIPPAGE_BPS });
      pendingBuyMints.add(mint);
      buys += 1;
    }

    return orders;
  },
});
