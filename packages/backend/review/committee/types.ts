import type {CommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import type {Manifest, Observation, Critique} from '../../../shared/src/contracts.ts';
import type {Dependencies} from '../workflow.ts';

export type EvidenceObservation = Observation & {evidenceHash:string};
export type EvidenceCritique = Critique & {evidenceHash:string};
export type CritiqueInput = Parameters<Dependencies['redTeam']>[0] & {evidence:CommitteeEvidence};
export interface CommitteeDependencies extends Omit<Dependencies,'role'|'risk'|'redTeam'> {
  role(evidence:CommitteeEvidence,signal:AbortSignal):Promise<EvidenceObservation[]>;
  risk(evidence:CommitteeEvidence,signal:AbortSignal):Promise<EvidenceObservation[]>;
  redTeam(input:CritiqueInput,signal:AbortSignal):Promise<EvidenceCritique[]>;
  /** Fail closed if validated node outputs cannot be durably audited. */
  audit(stage:'role'|'risk'|'redteam',evidence:CommitteeEvidence,outputs:(EvidenceObservation|EvidenceCritique)[],draft?:CritiqueInput):Promise<string[]>;
}
export interface CommitteeReceipt {
  schemaVersion:'1.0.0';mode:'PAPER';economicAuthority:false;
  evidenceHash:string;modelConfigHash:string;manifest:Manifest;auditIds:string[];receiptHash:string;
}
