import type { BookTicker, OrderBookSnapshot } from '../../shared/common.types';

/**
 * Holds the most recent book-ticker (top of book) and the most recent
 * partial-depth snapshot per symbol. No reconstruction of full book.
 */
export class OrderbookStore {
  private bookTicker = new Map<string, BookTicker>();
  private depthSnap = new Map<string, OrderBookSnapshot>();

  setBookTicker(bt: BookTicker): void { this.bookTicker.set(bt.symbol, bt); }
  setDepth(snap: OrderBookSnapshot): void { this.depthSnap.set(snap.symbol, snap); }

  getBookTicker(symbol: string): BookTicker | null {
    return this.bookTicker.get(symbol) ?? null;
  }

  getDepth(symbol: string): OrderBookSnapshot | null {
    return this.depthSnap.get(symbol) ?? null;
  }

  /** Mid price from bookTicker, or null if unknown. */
  midPrice(symbol: string): number | null {
    const bt = this.bookTicker.get(symbol);
    if (!bt) return null;
    return (bt.bid + bt.ask) / 2;
  }
}
