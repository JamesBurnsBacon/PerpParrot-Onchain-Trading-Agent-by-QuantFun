import type {CommitteeDependencies} from '../committee/types.ts';
export type CommitteeStage='role'|'risk'|'redteam';
export interface PaperModelOptions {
  apiKey:string;model:string;
  /** Defaults to shared/src/prompts.ts. */
  prompts?:Record<CommitteeStage,string>;
  /** OpenAI-compatible Chat Completions URL; defaults to OpenAI's. */
  endpoint?:string;
  fetcher?:typeof fetch;
}
export type PaperModelCore=Pick<CommitteeDependencies,'assess'|'clock'|'agentTimeoutMs'|'audit'>;
