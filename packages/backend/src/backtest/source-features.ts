export type PublicEvidence = {
  userFillsByTime: Record<string, unknown>[];
  userFunding: Record<string, unknown>[];
  userNonFundingLedgerUpdates: Record<string, unknown>[];
};

export type SourceFeatures = {
  fillCount: number | null;
  settlementCount: number;
  settlementPnlPctEquity: number | null;
  logTurnoverToEquity: number | null;
  makerNotionalShare: number | null;
  feeBpsOfNotional: number | null;
  assetNotionalHhi: number | null;
  logAssetCount: number | null;
  netFundingPctEquity: number | null;
  ledgerEventCount: number;
  distinctTransferCounterparties: number;
  transferCounterpartyHhi: number | null;
  netTransferPctEquity: number | null;
};

const finiteNumber = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const hhi = (values: number[]): number | null => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  return values.reduce((sum, value) => sum + (value / total) ** 2, 0);
};

function validateWindow(events: Record<string, unknown>[], startMs: number, endMs: number): void {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs >= endMs) throw new Error("invalid evidence window");
  for (const event of events) {
    const timestamp = finiteNumber(event.time);
    if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp < startMs || timestamp > endMs) {
      throw new Error("event outside requested evidence window");
    }
  }
}

/** Derive descriptive pre-cutoff features from public fills, funding, and ledger events. */
export function deriveSourceFeatures(input: {
  address: string;
  evidence: PublicEvidence;
  startMs: number;
  cutoffMs: number;
  startingEquity: number | null;
}): SourceFeatures {
  const { address, evidence, startMs, cutoffMs, startingEquity } = input;
  for (const events of [evidence.userFillsByTime, evidence.userFunding, evidence.userNonFundingLedgerUpdates]) {
    if (!Array.isArray(events)) throw new Error("evidence event collection must be an array");
    validateWindow(events, startMs, cutoffMs);
  }
  if (startingEquity !== null && (!Number.isFinite(startingEquity) || startingEquity <= 0)) throw new Error("starting equity must be positive");

  const fillIds = new Set<string>();
  const notionals = new Map<string, number>();
  let totalNotional = 0;
  let makerNotional = 0;
  let totalFees = 0;
  let feesUsdComplete = true;
  let settlementCount = 0;
  let settlementPnl = 0;
  for (const fill of evidence.userFillsByTime) {
    const id = fill.tid;
    if ((typeof id !== "string" && typeof id !== "number") || !Number.isFinite(Number(id))) throw new Error("fill is missing a valid trade id");
    const key = String(id);
    if (fillIds.has(key)) continue;
    fillIds.add(key);
    const px = finiteNumber(fill.px);
    const sz = finiteNumber(fill.sz);
    const fee = finiteNumber(fill.fee);
    if (sz === null || sz <= 0 || typeof fill.coin !== "string" || typeof fill.crossed !== "boolean") {
      throw new Error("malformed fill evidence");
    }
    if (fill.dir === "Settlement") {
      const pnl = finiteNumber(fill.closedPnl);
      if (px === null || px < 0 || pnl === null) throw new Error("malformed settlement evidence");
      settlementCount++;
      if (typeof fill.feeToken === "string" && fill.feeToken.toUpperCase() === "USDC") settlementPnl += pnl - Math.abs(fee ?? 0);
      else settlementPnl += pnl;
      continue;
    }
    if (px === null || fee === null || px <= 0) throw new Error("malformed fill evidence");
    const notional = px * sz;
    if (!Number.isFinite(notional)) throw new Error("fill notional overflow");
    totalNotional += notional;
    if (!fill.crossed) makerNotional += notional;
    if (typeof fill.feeToken === "string" && fill.feeToken.toUpperCase() === "USDC") totalFees += Math.abs(fee);
    else feesUsdComplete = false;
    notionals.set(fill.coin, (notionals.get(fill.coin) ?? 0) + notional);
  }

  let netFunding = 0;
  const fundingIds = new Set<string>();
  for (const event of evidence.userFunding) {
    const delta = object(event.delta);
    const amount = finiteNumber(delta?.usdc);
    if (amount === null || typeof delta?.coin !== "string") throw new Error("malformed funding evidence");
    const key = `${String(event.time)}:${String(event.hash)}:${delta.coin}:${String(delta.szi)}:${String(delta.usdc)}`;
    if (fundingIds.has(key)) continue;
    fundingIds.add(key);
    netFunding += amount;
  }

  let netTransfer = 0;
  const counterparties = new Set<string>();
  const valuedCounterparties = new Map<string, number>();
  let transferValuesComplete = true;
  const ledgerIds = new Set<string>();
  for (const event of evidence.userNonFundingLedgerUpdates) {
    const delta = object(event.delta);
    if (!delta) throw new Error("malformed ledger evidence");
    const identity = `${String(event.time)}:${String(event.hash)}:${JSON.stringify(delta)}`;
    if (ledgerIds.has(identity)) continue;
    ledgerIds.add(identity);
    // Count external address-to-address send events only. Deposits, withdrawals, and
    // protocol-specific ledger variants remain visible in the raw data, not misclassified.
    if (delta.type !== "send") continue;
    const usdcValue = finiteNumber(delta.usdcValue);
    const token = typeof delta.token === "string" ? delta.token.toUpperCase() : null;
    const amount = usdcValue ?? (token === "USDC" ? finiteNumber(delta.amount) : null);
    if (amount !== null && amount < 0) throw new Error("malformed transfer amount");
    const user = typeof delta.user === "string" ? delta.user.toLowerCase() : null;
    const destination = typeof delta.destination === "string" ? delta.destination.toLowerCase() : null;
    const normalizedAddress = address.toLowerCase();
    if (user !== null && user === destination) continue;
    let counterparty: string | null = null;
    if (destination === normalizedAddress && user !== null) {
      if (amount === null) transferValuesComplete = false;
      else netTransfer += amount;
      counterparty = user;
    } else if (user === normalizedAddress && destination !== null) {
      if (amount === null) transferValuesComplete = false;
      else netTransfer -= amount;
      counterparty = destination;
    }
    if (counterparty !== null) {
      counterparties.add(counterparty);
      if (amount !== null) valuedCounterparties.set(counterparty, (valuedCounterparties.get(counterparty) ?? 0) + amount);
    }
  }

  const concentration = [...notionals.values()];
  return {
    fillCount: fillIds.size - settlementCount,
    settlementCount,
    settlementPnlPctEquity: startingEquity === null ? null : settlementPnl / startingEquity,
    logTurnoverToEquity: startingEquity === null || totalNotional === 0 ? null : Math.log1p(totalNotional / startingEquity),
    makerNotionalShare: totalNotional === 0 ? null : makerNotional / totalNotional,
    feeBpsOfNotional: totalNotional === 0 || !feesUsdComplete ? null : totalFees / totalNotional * 10_000,
    assetNotionalHhi: hhi(concentration),
    logAssetCount: concentration.length === 0 ? null : Math.log1p(concentration.length),
    netFundingPctEquity: startingEquity === null ? null : netFunding / startingEquity,
    ledgerEventCount: ledgerIds.size,
    distinctTransferCounterparties: counterparties.size,
    transferCounterpartyHhi: !transferValuesComplete ? null : hhi([...valuedCounterparties.values()]),
    netTransferPctEquity: startingEquity === null || !transferValuesComplete ? null : netTransfer / startingEquity,
  };
}

export function spearman(x: (number | null)[], y: (number | null)[]): { n: number; rho: number | null } {
  if (x.length !== y.length) throw new Error("correlation arrays must align");
  const pairs = x.flatMap((value, index) => value !== null && y[index] !== null ? [[value, y[index]!] as const] : []);
  if (pairs.length < 3) return { n: pairs.length, rho: null };
  const ranks = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const result = new Array<number>(values.length);
    for (let start = 0; start < order.length;) {
      let end = start + 1;
      while (end < order.length && order[end].value === order[start].value) end++;
      const rank = ((start + 1) + end) / 2;
      for (let i = start; i < end; i++) result[order[i].index] = rank;
      start = end;
    }
    return result;
  };
  const rx = ranks(pairs.map(([a]) => a));
  const ry = ranks(pairs.map(([, b]) => b));
  const meanX = rx.reduce((sum, value) => sum + value, 0) / rx.length;
  const meanY = ry.reduce((sum, value) => sum + value, 0) / ry.length;
  const covariance = rx.reduce((sum, value, i) => sum + (value - meanX) * (ry[i] - meanY), 0);
  const scaleX = Math.sqrt(rx.reduce((sum, value) => sum + (value - meanX) ** 2, 0));
  const scaleY = Math.sqrt(ry.reduce((sum, value) => sum + (value - meanY) ** 2, 0));
  return { n: pairs.length, rho: scaleX === 0 || scaleY === 0 ? null : covariance / (scaleX * scaleY) };
}
