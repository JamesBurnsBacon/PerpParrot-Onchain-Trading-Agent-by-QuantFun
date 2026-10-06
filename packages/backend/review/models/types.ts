import type {CommitteeDependencies} from '../../../cre-workflows/review/committee/types.ts';
export type CommitteeStage='role'|'risk'|'redteam';
export interface PaperModelOptions {
  apiKey:string;model:string;prompts:Record<CommitteeStage,string>;fetcher?:typeof fetch;
}
export type PaperModelCore=Pick<CommitteeDependencies,'assess'|'clock'|'agentTimeoutMs'|'audit'>;
