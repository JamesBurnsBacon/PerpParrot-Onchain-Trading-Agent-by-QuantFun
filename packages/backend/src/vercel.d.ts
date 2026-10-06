declare module "@vercel/functions" {
  /** Keep snapshot and artifact persistence alive after serverless response returns. */
  export function waitUntil(work: Promise<unknown>): void;
}
