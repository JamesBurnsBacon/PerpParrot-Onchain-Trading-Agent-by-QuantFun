// Offline, hand-drawn approximation of the six-fold OpenAI blossom.
// MUST replace with the official brand asset before publishing. All path data lives here.
export function OpenAIMark() {
  return <svg className="openai-mark" viewBox="0 0 64 64" width="25" height="25" role="img" aria-label="OpenAI">
    <title>OpenAI</title>
    <g fill="none" stroke="currentColor" strokeWidth="3.3" strokeLinecap="round" strokeLinejoin="round">
      {[0, 60, 120, 180, 240, 300].map(angle => <path key={angle} transform={`rotate(${angle} 32 32)`} d="M32 10C23 4 12 10 12 21v17l20 12 10-6V25L27 16l-9 5v14l14 8" />)}
    </g>
  </svg>;
}
