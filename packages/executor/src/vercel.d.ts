declare module "@vercel/functions" {
  /** Keep accepted report processing alive after a serverless response returns. */
  export function waitUntil(work: Promise<unknown>): void;
}
