// Immutable initial-screening evidence, reused by scheduled portfolio refreshes.
export type FillStats={asOf:string;startTime:number;endTime:number;orderCount:number;tradeCount:number|null;
  fills:number;pages:number;complete:boolean;makerShare:number|null;medianHoldHours:number|null;flags:string[]};
