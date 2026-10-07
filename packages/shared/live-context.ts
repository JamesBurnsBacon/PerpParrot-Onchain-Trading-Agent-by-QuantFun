// Read-only context shape shared by the Live handler and dashboard guards.
// Never include this display context in strategy preferences or a saved preview.
export type LiveContext = {
  facts: string[];
  compare?: { total: number; existing: number; new: number };
  paper?: { bookId: string; label: string; returnPct: number; days: number }[];
  book?: { gross: number; top: { asset: string; fraction: number }[] };
};
