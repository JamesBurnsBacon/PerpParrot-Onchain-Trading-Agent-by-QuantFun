import type { WalletVibe } from "../../../shared/wallet-persona";

// Inline clay shapes keep each bird crisp at both compact and desktop sizes.
export function WalletBird({ vibe }: { vibe: WalletVibe }) {
  return <svg className="wallet-bird" viewBox="0 0 140 132" aria-hidden="true" focusable="false">
    <ellipse cx="70" cy="120" rx="43" ry="7" fill="#262c48" opacity=".09" />
    <path d="M26 112H114" stroke="#262c48" strokeWidth="9" strokeLinecap="round" />
    <path d="m58 94-5 18m27-18 5 18" stroke="#f29a2e" strokeWidth="8" strokeLinecap="round" />
    <path d="m62 91 12 26 12-29" fill="#3f9a3a" />
    <ellipse cx="70" cy="68" rx="37" ry="40" fill="#3f9a3a" />
    <ellipse cx="67" cy="63" rx="33" ry="37" fill="#6cc04a" />
    <ellipse cx="70" cy="80" rx="23" ry="21" fill="#b4df7e" />
    <path className="wallet-wing" d="M39 61Q19 67 34 95Q55 89 51 69" fill="#3f9a3a" stroke="#327b32" strokeWidth="2" />
    {vibe === "wild" ? <>
      <path d="m59 31-8-22 17 15 7-20 7 22 14-10-7 21" fill="#6cc04a" stroke="#3f9a3a" strokeWidth="3" strokeLinejoin="round" />
      <circle cx="58" cy="49" r="14" fill="#fffcf5" /><circle cx="86" cy="53" r="15" fill="#fffcf5" />
      <circle cx="54" cy="45" r="5" fill="#262c48" /><circle cx="91" cy="57" r="5" fill="#262c48" />
      <path d="M114 40q-14 17 0 19q13-2 0-19" fill="#f29a2e" />
    </> : vibe === "calm" ? <>
      <path d="M45 51q8 9 16 0m14 0q8 9 16 0" fill="none" stroke="#262c48" strokeWidth="4" strokeLinecap="round" />
      <path d="m64 30-8-11q16-4 21 11" fill="#6cc04a" />
      <text x="104" y="32" fill="#262c48" fontSize="19" fontWeight="900">z</text>
    </> : <>
      <path d="m63 30-5-12q17 0 21 13" fill="#6cc04a" />
      <ellipse cx="56" cy="51" rx="10" ry="12" fill="#fffcf5" /><ellipse cx="83" cy="51" rx="10" ry="12" fill="#fffcf5" />
      <circle cx="58" cy="52" r="4" fill="#262c48" /><circle cx="81" cy="52" r="4" fill="#262c48" />
      <path d="M64 76q7 5 13-1" fill="none" stroke="#262c48" strokeWidth="3" strokeLinecap="round" />
    </>}
    <path d="M63 63q10-12 21 0L71 76Z" fill="#f29a2e" stroke="#c97820" strokeWidth="2" strokeLinejoin="round" />
    <ellipse cx="45" cy="66" rx="6" ry="3" fill="#f29a2e" opacity=".65" />
    <path d="M42 39q5-8 13-9" stroke="#d2eca7" strokeWidth="5" strokeLinecap="round" opacity=".7" />
  </svg>;
}
