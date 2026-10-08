"use client";
import { useEffect, useRef, useState } from "react";
import "../lp.css";
import "./nownodes.css";
import { Panel } from "../../components/Charts";
import { Parrot, ParrotSymbols } from "../../components/lp/ParrotSymbols";
import { ScrollBuddy } from "../../components/lp/ScrollBuddy";
import { useDashMotion } from "../../components/lp/useDashMotion";

// The page for the NOWNodes challenge judges: how the data moves, and how NOWNodes and the official
// Hyperliquid API are combined. The diagrams are drawn here; the proof panel reads the live backend.

type Provider = { requests: number; errors: number; totalMs: number };
type Proof = {
  mode: string;
  official: Provider;
  nownodes: Provider;
  fallbacks: number;
  breakerOpen: boolean;
  verification: { mode: string; verified: number; mismatches: number };
};

const INK = "var(--ink)";
const stroke = { fill: "none", stroke: INK, strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;


// A pull-down with the numbers behind a diagram. Each row is read from the code or the ops docs named in the comment above its use.
function Logic({ rows }: { rows: [string, string][] }) {
  return (
    <details className="nn-logic">
      <summary>Logic in numbers</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// vercel.json crons and AGENTS.md (pipeline).
const FLOW_ROWS: [string, string][] = [
  ["Scan", "00:15 and 12:15 UTC (every 12 h)"],
  ["Refresh", "every 5 min"],
  ["Select · Roster", "every 10 min each"],
  ["Snapshot · Executor", "every 10 min each"],
  ["Qualified → picked", "about 250 → 25"],
];
// info-router.ts constants; DEPLOY.md; README (benchmark).
const ROUTER_ROWS: [string, string][] = [
  ["Methods on NOWNodes", "8 of the 16 probed"],
  ["Load split", "INFO_SPLIT_PERCENT, default 25 % NOWNodes-first"],
  ["Bulk reads", "100 % NOWNodes-first"],
  ["Failover timeout", "15 s"],
  ["Breaker", "3 failures in a row → 60 s pause"],
  ["Probe", "every 6 h per instance, can only narrow"],
  ["Official budget", "1,200 weight/min"],
  ["Latency", "NOWNodes about 1.7× official (median 0.36 s vs 0.21 s)"],
];
// snapshot-verify.ts; DEPLOY.md.
const CHECK_ROWS: [string, string][] = [
  ["Tolerance", "1 % per asset, never below $5"],
  ["Valid setting", "above 0 and up to 50 %, else 1 %"],
  ["On a mismatch", "both providers re-read; stored only if they agree with each other and with the snapshot"],
  ["NOWNodes unreadable", "on: store anyway · strict: refuse"],
  ["Read timeout", "snapshot 15 s · pipeline 20 s"],
  ["Covers", "positions (clearinghouseState), not portfolio equity"],
];
// overlap-pick.ts; frozen-configuration.json; DEPLOY.md.
const BULK_ROWS: [string, string][] = [
  ["Pool", "top 60 candidates"],
  ["Reads", "about 120 clearinghouseState calls"],
  ["Time", "about 2 s in parallel (local benchmark)"],
  ["Official weight used", "0 while NOWNodes answers"],
  ["Overlap limit", "0.5 (frozen policy; may tighten to 0.4)"],
  ["Pick size", "25, never shrinks"],
  ["Read timeout", "15 s"],
];
// contract-check.ts; README (2026-10-07).
const CONTRACT_ROWS: [string, string][] = [
  ["Call", "eth_getCode on /evm, 15 s timeout"],
  ["Top 300 by month PnL", "8 had code (7 on a later run)"],
  ["NOWNodes vs public RPC", "agreed on 300 of 300"],
  ["Failed read", "'unread', never 'not a contract'"],
];

// ---------- 1. data flow ----------
const NODES = [
  { id: "scan", label: "Scan", cad: "every 12 h", x: 25 },
  { id: "score", label: "Score", cad: "every 5 min", x: 225 },
  { id: "pick", label: "AI pick", cad: "every 10 min", x: 425 },
  { id: "snap", label: "Snapshot", cad: "every 10 min", x: 625 },
  { id: "exec", label: "Executor", cad: "every 10 min", x: 825 },
] as const;

function Icon({ id, cx, cy }: { id: string; cx: number; cy: number }) {
  switch (id) {
    case "scan":
      return (
        <g {...stroke}>
          <circle cx={cx - 3} cy={cy - 3} r={10} />
          <path d={`M${cx + 5} ${cy + 5}L${cx + 13} ${cy + 13}`} />
        </g>
      );
    case "score":
      return (
        <g {...stroke}>
          <path d={`M${cx - 12} ${cy + 12}V${cy + 2}M${cx} ${cy + 12}V${cy - 8}M${cx + 12} ${cy + 12}V${cy - 14}`} strokeWidth={5} />
        </g>
      );
    case "pick":
      return <path d={`M${cx} ${cy - 15}L${cx + 4} ${cy - 4}L${cx + 15} ${cy}L${cx + 4} ${cy + 4}L${cx} ${cy + 15}L${cx - 4} ${cy + 4}L${cx - 15} ${cy}L${cx - 4} ${cy - 4}Z`} fill="#eac744" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />;
    case "snap":
      return (
        <g {...stroke}>
          <rect x={cx - 14} y={cy - 9} width={28} height={20} rx={5} />
          <circle cx={cx} cy={cy + 1} r={5} />
        </g>
      );
    default:
      return (
        <g {...stroke}>
          <path d={`M${cx - 13} ${cy}H${cx + 13}M${cx + 5} ${cy - 8}L${cx + 13} ${cy}L${cx + 5} ${cy + 8}`} />
        </g>
      );
  }
}

function FlowDiagram() {
  return (
    <svg className="nn-svg" viewBox="0 0 1000 570" role="img" aria-label="Data flow: scan, score, AI pick, snapshot and executor. The first four read Hyperliquid through one router that uses the official API and NOWNodes. The executor sends orders directly.">
      <defs>
        <marker id="nn-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#3f9a3a" />
        </marker>
        <marker id="nn-ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#d9822f" />
        </marker>
        <marker id="nn-ab" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#3f78b0" />
        </marker>
        <marker id="nn-ag" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#7a7868" />
        </marker>
      </defs>

      {/* the five jobs */}
      {NODES.map((n, i) => (
        <g key={n.id} className="nn-pop">
          <rect x={n.x} y={34} width={150} height={92} rx={26} fill="#fffcf5" stroke="#fff" strokeWidth={4} style={{ filter: "drop-shadow(0 6px 0 rgba(48,41,27,.08))" }} />
          <Icon id={n.id} cx={n.x + 75} cy={66} />
          <text x={n.x + 75} y={106} textAnchor="middle" fontSize={19} fontWeight={900} fill={INK}>
            {n.label}
          </text>
          <rect x={n.x + 22} y={134} width={106} height={24} rx={12} fill="#f9e7a6" />
          <text x={n.x + 75} y={151} textAnchor="middle" fontSize={12} fontWeight={800} fill="#6b4a07">
            {n.cad}
          </text>
          {i < NODES.length - 1 && <path d={`M${n.x + 154} 80H${n.x + 196}`} stroke="#3f9a3a" strokeWidth={3.5} markerEnd="url(#nn-a)" className="nn-flow" />}
        </g>
      ))}

      {/* reads drop into the router */}
      {[100, 300, 500, 700].map((x) => (
        <path key={x} d={`M${x} 164V232`} stroke="#3f9a3a" strokeWidth={3.5} markerEnd="url(#nn-a)" className="nn-flow" />
      ))}

      {/* router */}
      <rect x={40} y={236} width={700} height={74} rx={30} fill="#e4eacf" stroke="#3f9a3a" strokeWidth={3.5} />
      <text x={390} y={270} textAnchor="middle" fontSize={24} fontWeight={950} fill="#286324">
        Read router
      </text>
      <text x={390} y={294} textAnchor="middle" fontSize={13} fontWeight={700} fill="#555449">
        capability · load split · failover · breaker
      </text>

      {/* two roads */}
      <path d="M220 312C220 345 230 352 230 380" stroke="#3f78b0" strokeWidth={4} markerEnd="url(#nn-ab)" className="nn-flow" fill="none" />
      <path d="M560 312C560 345 550 352 550 380" stroke="#d9822f" strokeWidth={4} markerEnd="url(#nn-ao)" className="nn-flow" fill="none" />

      <g className="nn-pop">
        <rect x={90} y={384} width={280} height={86} rx={26} fill="#cfe4f2" stroke="#3f78b0" strokeWidth={3.5} />
        <text x={230} y={416} textAnchor="middle" fontSize={20} fontWeight={950} fill="#234e75">
          Official API
        </text>
        <text x={230} y={438} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#234e75">
          portfolio · fills · funding
        </text>
        <text x={230} y={456} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#555449">
          api.hyperliquid.xyz
        </text>
      </g>
      <g className="nn-pop">
        <rect x={410} y={384} width={280} height={86} rx={26} fill="#fbd9b4" stroke="#d9822f" strokeWidth={3.5} />
        <text x={550} y={416} textAnchor="middle" fontSize={20} fontWeight={950} fill="#7b4410">
          NOWNodes
        </text>
        <text x={550} y={438} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#7b4410">
          8 info methods · HyperEVM
        </text>
        <text x={550} y={456} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#555449">
          hype.nownodes.io
        </text>
      </g>

      {/* failover between the two */}
      <path d="M376 412H404" stroke="#7a7868" strokeWidth={3} markerEnd="url(#nn-ag)" />
      <path d="M404 436H376" stroke="#7a7868" strokeWidth={3} markerEnd="url(#nn-ag)" />
      <text x={390} y={428} textAnchor="middle" fontSize={9.5} fontWeight={900} fill="#7a7868">
        failover
      </text>

      {/* both end at Hyperliquid */}
      <path d="M230 472C230 490 330 486 350 508" stroke="#3f78b0" strokeWidth={3.5} fill="none" markerEnd="url(#nn-ab)" className="nn-flow" />
      <path d="M550 472C550 490 450 486 430 508" stroke="#d9822f" strokeWidth={3.5} fill="none" markerEnd="url(#nn-ao)" className="nn-flow" />
      <rect x={290} y={508} width={200} height={50} rx={25} fill="#3f9a3a" />
      <text x={390} y={540} textAnchor="middle" fontSize={20} fontWeight={950} fill="#fff">
        Hyperliquid
      </text>

      {/* the executor is not routed */}
      <path d="M900 164V533H496" stroke="#7a7868" strokeWidth={3} strokeDasharray="3 8" fill="none" markerEnd="url(#nn-ag)" />
      <rect x={812} y={330} width={176} height={54} rx={18} fill="#fffcf5" stroke="#d8c9a8" strokeWidth={2} />
      <text x={900} y={353} textAnchor="middle" fontSize={13} fontWeight={900} fill={INK}>
        orders go direct
      </text>
      <text x={900} y={372} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#7a7868">
        never via NOWNodes
      </text>
    </svg>
  );
}

// ---------- 2. router ----------
const ON_NOWNODES = ["meta", "perpDexs", "clearinghouseState", "spotClearinghouseState", "webData2", "userVaultEquities", "spotMeta", "vaultSummaries"];
const OFFICIAL_ONLY = ["portfolio", "userFills", "userFunding", "l2Book", "allMids", "candleSnapshot"];

function RouterPanel() {
  return (
    <>
      <div className="nn-split">
        <div className="nn-lane o">
          <h3>Official API</h3>
          <small>everything NOWNodes answers 422 for</small>
          <div className="nn-chips">
            {OFFICIAL_ONLY.map((m) => (
              <span key={m} className="nn-chip">
                {m}
              </span>
            ))}
          </div>
        </div>
        <div className="nn-mid">
          <span className="arrows">⇄</span>
          <span>each read<br />picks a road</span>
        </div>
        <div className="nn-lane n">
          <h3>NOWNodes</h3>
          <small>supported reads, a share goes here first</small>
          <div className="nn-chips">
            {ON_NOWNODES.map((m) => (
              <span key={m} className="nn-chip">
                {m}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="nn-traits">
        <div className="nn-trait">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="18" fill="#f9e7a6" />
            <path d="M8 22a12 12 0 0 1 24 0" {...stroke} />
            <path d="M20 22L27 14" {...stroke} strokeWidth={3} />
            <circle cx="20" cy="22" r="2.5" fill={INK} />
          </svg>
          <div>
            <b>Load split</b>
            <span>spares the 1,200 weight/min limit</span>
          </div>
        </div>
        <div className="nn-trait">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="18" fill="#f8d6c8" />
            <path d="M20 8V22" {...stroke} strokeWidth={3.4} />
            <circle cx="20" cy="29" r="2.6" fill={INK} />
          </svg>
          <div>
            <b>Breaker</b>
            <span>3 misses in a row pause it 60 s</span>
          </div>
        </div>
        <div className="nn-trait">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <circle cx="20" cy="20" r="18" fill="#cfe4f2" />
            <circle cx="18" cy="18" r="7" {...stroke} />
            <path d="M23 23L30 30" {...stroke} strokeWidth={3} />
          </svg>
          <div>
            <b>Probe</b>
            <span>re-checks the 16 methods every 6 h</span>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- 3. cross-check ----------
function CrossCheck() {
  return (
    <svg className="nn-svg" viewBox="0 0 1000 300" role="img" aria-label="Cross-check: the snapshot read from the first provider is compared with a second read from the other; a match is stored, a mismatch stops the run.">
      <defs>
        <marker id="nn-cg" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#3f9a3a" />
        </marker>
        <marker id="nn-cr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#d9582f" />
        </marker>
        <marker id="nn-cb" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#3f78b0" />
        </marker>
        <marker id="nn-co" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#d9822f" />
        </marker>
      </defs>
      <g className="nn-pop">
        <rect x={20} y={36} width={230} height={76} rx={26} fill="#cfe4f2" stroke="#3f78b0" strokeWidth={3.5} />
        <text x={135} y={68} textAnchor="middle" fontSize={18} fontWeight={950} fill="#234e75">
          Snapshot read
        </text>
        <text x={135} y={92} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#234e75">
          positions of every source
        </text>
      </g>
      <g className="nn-pop">
        <rect x={20} y={188} width={230} height={76} rx={26} fill="#fbd9b4" stroke="#d9822f" strokeWidth={3.5} />
        <text x={135} y={220} textAnchor="middle" fontSize={18} fontWeight={950} fill="#7b4410">
          Second read
        </text>
        <text x={135} y={244} textAnchor="middle" fontSize={12.5} fontWeight={700} fill="#7b4410">
          same accounts, other provider
        </text>
      </g>
      <path d="M254 76C330 76 340 130 382 140" stroke="#3f78b0" strokeWidth={4} fill="none" markerEnd="url(#nn-cb)" className="nn-flow" />
      <path d="M254 226C330 226 340 170 382 160" stroke="#d9822f" strokeWidth={4} fill="none" markerEnd="url(#nn-co)" className="nn-flow" />

      <circle cx={450} cy={150} r={62} fill="#f9e7a6" stroke="#c99a12" strokeWidth={3.5} />
      <text x={450} y={162} textAnchor="middle" fontSize={44} fontWeight={950} fill="#6b4a07">
        ≈
      </text>
      <text x={450} y={238} textAnchor="middle" fontSize={13} fontWeight={800} fill="#6b4a07">
        asset by asset · 1 %
      </text>

      <path d="M506 124C560 90 575 80 612 78" stroke="#3f9a3a" strokeWidth={4} fill="none" markerEnd="url(#nn-cg)" className="nn-flow" />
      <path d="M506 176C560 210 575 222 612 224" stroke="#d9582f" strokeWidth={4} fill="none" markerEnd="url(#nn-cr)" className="nn-flow" />
      <text x={560} y={78} fontSize={12} fontWeight={900} fill="#286324">
        match
      </text>
      <text x={548} y={252} fontSize={12} fontWeight={900} fill="#a83a1a">
        mismatch
      </text>

      <g className="nn-pop">
        <rect x={620} y={34} width={360} height={90} rx={28} fill="#cfe9bd" stroke="#3f9a3a" strokeWidth={3.5} />
        <path d="M646 80L660 94L686 62" stroke="#286324" strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <text x={706} y={72} fontSize={17} fontWeight={950} fill="#286324">
          Stored and hashed
        </text>
        <text x={706} y={96} fontSize={12.5} fontWeight={700} fill="#286324">
          the executor sizes orders from it
        </text>
      </g>
      <g className="nn-pop">
        <rect x={620} y={178} width={360} height={90} rx={28} fill="#f8d6c8" stroke="#d9582f" strokeWidth={3.5} />
        <path d="M648 208L674 234M674 208L648 234" stroke="#a83a1a" strokeWidth={6} fill="none" strokeLinecap="round" />
        <text x={706} y={216} fontSize={17} fontWeight={950} fill="#a83a1a">
          Nothing stored
        </text>
        <text x={706} y={240} fontSize={12.5} fontWeight={700} fill="#a83a1a">
          the run fails, the next one rebuilds
        </text>
      </g>
    </svg>
  );
}

// ---------- 4. bulk reads and contracts ----------
const OVERLAP = new Set([7, 12, 19, 31, 44]); // illustration: which of the 60 candidates the guard leaves out

function BulkGuard() {
  const dots = Array.from({ length: 60 }, (_, i) => i);
  let chosen = 0;
  const picks = dots.map((i) => (OVERLAP.has(i) ? null : chosen++ < 25 ? "pick" : "rest"));
  return (
    <svg className="nn-svg" viewBox="0 0 520 250" role="img" aria-label="Overlap guard: 60 candidates are read from NOWNodes first, overlapping ones are left out, 25 are picked.">
      <defs>
        <marker id="nn-bo" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#d9822f" />
        </marker>
      </defs>
      {dots.map((i) => {
        const cx = 22 + (i % 10) * 19;
        const cy = 40 + Math.floor(i / 10) * 19;
        const kind = picks[i];
        return kind === null ? (
          <g key={i}>
            <circle cx={cx} cy={cy} r={7} fill="#fbd9b4" stroke="#d9822f" strokeWidth={1.6} />
            <path d={`M${cx - 3} ${cy - 3}L${cx + 3} ${cy + 3}M${cx + 3} ${cy - 3}L${cx - 3} ${cy + 3}`} stroke="#a85d12" strokeWidth={1.6} strokeLinecap="round" />
          </g>
        ) : (
          <circle key={i} cx={cx} cy={cy} r={7} fill={kind === "pick" ? "#6cc04a" : "#e7dcc6"} />
        );
      })}
      <text x={110} y={20} textAnchor="middle" fontSize={13} fontWeight={900} fill={INK}>
        60 candidates
      </text>
      <path d="M218 98H300" stroke="#d9822f" strokeWidth={4} markerEnd="url(#nn-bo)" className="nn-flow" />
      <rect x={222} y={118} width={86} height={48} rx={16} fill="#fbd9b4" />
      <text x={265} y={138} textAnchor="middle" fontSize={11.5} fontWeight={950} fill="#7b4410">
        NOWNodes
      </text>
      <text x={265} y={155} textAnchor="middle" fontSize={11} fontWeight={700} fill="#7b4410">
        ~120 reads
      </text>
      {Array.from({ length: 25 }, (_, i) => (
        <circle key={i} cx={338 + (i % 5) * 24} cy={50 + Math.floor(i / 5) * 24} r={9} fill="#6cc04a" />
      ))}
      <text x={398} y={20} textAnchor="middle" fontSize={13} fontWeight={900} fill={INK}>
        25 picked
      </text>
      <rect x={20} y={176} width={480} height={56} rx={20} fill="#f9e7a6" />
      <text x={260} y={199} textAnchor="middle" fontSize={13} fontWeight={900} fill="#6b4a07">
        about 2 s in parallel · none of the official weight
      </text>
      <text x={260} y={218} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#6b4a07">
        failed read or paused NOWNodes: the pick stays as scored
      </text>
    </svg>
  );
}

function ContractCheck() {
  return (
    <svg className="nn-svg" viewBox="0 0 330 250" role="img" aria-label="Contract check: each pick address is checked with eth_getCode on NOWNodes' HyperEVM endpoint and tagged as contract or plain account.">
      <defs>
        <marker id="nn-ko" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M1 1L9 5L1 9Z" fill="#d9822f" />
        </marker>
      </defs>
      <rect x={20} y={20} width={140} height={40} rx={20} fill="#fffcf5" stroke="#d8c9a8" strokeWidth={2} />
      <text x={90} y={46} textAnchor="middle" fontSize={14} fontWeight={800} fill={INK} fontFamily="ui-monospace, monospace">
        0x7f3…a9c1
      </text>
      <path d="M90 64V104" stroke="#d9822f" strokeWidth={4} markerEnd="url(#nn-ko)" className="nn-flow" />
      <rect x={20} y={108} width={190} height={50} rx={18} fill="#fbd9b4" />
      <text x={115} y={130} textAnchor="middle" fontSize={13} fontWeight={950} fill="#7b4410">
        NOWNodes /evm
      </text>
      <text x={115} y={148} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#7b4410" fontFamily="ui-monospace, monospace">
        eth_getCode
      </text>
      <path d="M213 133H224" stroke="#7a7868" strokeWidth={3} />
      <rect x={226} y={100} width={96} height={30} rx={15} fill="#e0d8f3" stroke="#7a6bb5" strokeWidth={2} />
      <text x={274} y={120} textAnchor="middle" fontSize={11.5} fontWeight={900} fill="#4d4080">
        {"</> contract"}
      </text>
      <rect x={226} y={138} width={96} height={30} rx={15} fill="#e7dcc6" />
      <text x={274} y={158} textAnchor="middle" fontSize={12} fontWeight={900} fill="#555449">
        plain
      </text>
      <rect x={20} y={186} width={292} height={44} rx={18} fill="#f9e7a6" />
      <text x={166} y={206} textAnchor="middle" fontSize={12.5} fontWeight={900} fill="#6b4a07">
        evidence only
      </text>
      <text x={166} y={222} textAnchor="middle" fontSize={11.5} fontWeight={700} fill="#6b4a07">
        marks the table, never excludes
      </text>
    </svg>
  );
}

// ---------- 5. live proof ----------
const SAMPLE: Proof = {
  mode: "split",
  official: { requests: 9, errors: 0, totalMs: 1521 },
  nownodes: { requests: 14, errors: 0, totalMs: 7102 },
  fallbacks: 0,
  breakerOpen: false,
  verification: { mode: "on", verified: 0, mismatches: 0 },
};

function useProof(): { proof: Proof; live: boolean } {
  const [state, setState] = useState<{ proof: Proof; live: boolean }>({ proof: SAMPLE, live: false });
  useEffect(() => {
    let off = false;
    fetch("/api/backend/pipeline")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (off || !d?.routing || !d?.verification) return;
        const { routing: r, verification: v } = d;
        setState({
          live: true,
          proof: { mode: r.mode, official: r.official, nownodes: r.nownodes, fallbacks: r.fallbacks, breakerOpen: r.breakerOpen, verification: { mode: v.mode, verified: v.verified, mismatches: v.mismatches } },
        });
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);
  return state;
}

function ProofPanel() {
  const { proof, live } = useProof();
  const max = Math.max(proof.official.requests, proof.nownodes.requests, 1);
  const avg = (p: Provider) => (p.requests ? `${Math.round(p.totalMs / p.requests)} ms avg` : "no reads yet");
  const rows = [
    { key: "o", name: "Official", p: proof.official },
    { key: "n", name: "NOWNodes", p: proof.nownodes },
  ] as const;
  return (
    <div className="nn-proof">
      {rows.map(({ key, name, p }) => (
        <div className="nn-row" key={key}>
          <b>{name}</b>
          <span className="nn-track">
            <span className={`nn-fill ${key}`} style={{ display: "block", width: `${(p.requests / max) * 100}%` }} />
          </span>
          <span className="num">
            {p.requests} reads · {p.errors} errors · {avg(p)}
          </span>
        </div>
      ))}
      <div className="nn-badges">
        <span className="nn-badge">
          <i />
          routing: {proof.mode}
        </span>
        <span className="nn-badge">
          <i className={proof.fallbacks ? "" : ""} />
          failovers: {proof.fallbacks}
        </span>
        <span className="nn-badge">
          <i className={proof.breakerOpen ? "off" : ""} />
          breaker: {proof.breakerOpen ? "open" : "closed"}
        </span>
        <span className="nn-badge">
          <i className={proof.verification.mode === "off" ? "off" : ""} />
          cross-check: {proof.verification.mode} · {proof.verification.verified} verified · {proof.verification.mismatches} mismatches
        </span>
        <span className="nn-badge">{live ? "live, this instance" : "sample"}</span>
      </div>
    </div>
  );
}

// ---------- 6. why both ----------
function WhyBoth() {
  return (
    <>
      <div className="nn-why">
        <div>
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <circle cx="42" cy="42" r="38" fill="#f9e7a6" />
            <path d="M16 52a26 26 0 0 1 52 0" {...stroke} strokeWidth={4} />
            <path d="M42 52L58 30" {...stroke} strokeWidth={5} />
            <circle cx="42" cy="52" r="5" fill={INK} />
          </svg>
          <b>Capacity</b>
          <span>bulk reads leave the official budget alone</span>
        </div>
        <div>
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <circle cx="42" cy="42" r="38" fill="#cfe4f2" />
            <path d="M18 62L38 22M66 62L46 22" {...stroke} strokeWidth={5} />
            <path d="M42 40V46M42 56V62" {...stroke} strokeWidth={4} />
          </svg>
          <b>Redundancy</b>
          <span>either road can carry the other</span>
        </div>
        <div>
          <svg viewBox="0 0 84 84" aria-hidden="true">
            <circle cx="42" cy="42" r="38" fill="#cfe9bd" />
            <circle cx="30" cy="38" r="12" {...stroke} fill="#fff" />
            <circle cx="54" cy="38" r="12" {...stroke} fill="#fff" />
            <circle cx="30" cy="38" r="4.5" fill={INK} />
            <circle cx="54" cy="38" r="4.5" fill={INK} />
            <path d="M28 62L38 70L58 54" {...stroke} strokeWidth={5} stroke="#286324" />
          </svg>
          <b>Second opinion</b>
          <span>a snapshot is checked before it trades</span>
        </div>
      </div>
      <div className="nn-honest">
        <span>NOWNodes answers more slowly per read, so it is used for capacity and checks, not for speed</span>
      </div>
    </>
  );
}

export default function NowNodesPage() {
  const dash = useRef<HTMLDivElement>(null);
  useDashMotion(dash, true);
  return (
    <div className="lp nn">
      <ParrotSymbols />
      <div className="lp-dh">
        <ScrollBuddy />
        <a className="lp-dbrand" href="#top">
          <Parrot />
          <b>PerpParrot</b>
        </a>
        <nav aria-label="NOWNodes sections">
          <a href="#flow">Flow</a>
          <a href="#router">Router</a>
          <a href="#check">Check</a>
          <a href="#proof">Proof</a>
        </nav>
        <div className="lp-dh-actions">
          <a className="lp-dh-action" href="/">
            Dashboard
          </a>
        </div>
      </div>

      <section className="nn-hero" id="top">
        <div className="nn-surface">
          <div className="nn-hill" aria-hidden="true" />
          <div>
            <span className="nn-kicker">NOWNodes Multichain Infrastructure Challenge</span>
            <h1 className="nn-title">
              Two roads,
              <br />
              <span className="a">one answer.</span>
            </h1>
            <div className="nn-equation">
              <span className="nn-pill o">Official API</span>
              <span className="nn-op">+</span>
              <span className="nn-pill n">NOWNodes</span>
              <span className="nn-op">=</span>
              <span className="nn-pill a">a snapshot we can trust</span>
            </div>
          </div>
          <div className="nn-mascot" aria-hidden="true">
            <div className="ring" />
            <div className="face">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/lp/mascot.jpg" alt="" />
            </div>
            <div className="chip o">Official</div>
            <div className="chip n">NOW<br />Nodes</div>
          </div>
        </div>
      </section>

      <div className="lp-dash-wrap" ref={dash}>
        <main className="lp-dash">
          <div className="mb-4">
            <Panel id="flow" tone={1} title="How the data moves" meta="every 10 minutes">
              <FlowDiagram />
              <Logic rows={FLOW_ROWS} />
            </Panel>
          </div>
          <div className="mb-4">
            <Panel id="router" tone={4} title="One router, two providers">
              <RouterPanel />
              <Logic rows={ROUTER_ROWS} />
            </Panel>
          </div>
          <div className="mb-4">
            <Panel id="check" tone={2} title="A second opinion before every trade">
              <CrossCheck />
              <Logic rows={CHECK_ROWS} />
            </Panel>
          </div>
          <div className="nn-duo mb-4">
            <Panel tone={3} title="Bulk reads">
              <BulkGuard />
              <Logic rows={BULK_ROWS} />
            </Panel>
            <Panel tone={5} title="Contract check">
              <ContractCheck />
              <Logic rows={CONTRACT_ROWS} />
            </Panel>
          </div>
          <div className="mb-4">
            <Panel id="proof" tone={1} peek="right" title="Running now" meta="from /pipeline">
              <ProofPanel />
            </Panel>
          </div>
          <div className="mb-4">
            <Panel tone={2} title="Why both">
              <WhyBoth />
            </Panel>
          </div>
        </main>
        <footer className="lp-foot">
          <div className="lp-foot-brand">
            <Parrot />
            <b>PerpParrot</b>
          </div>
        </footer>
      </div>
    </div>
  );
}
