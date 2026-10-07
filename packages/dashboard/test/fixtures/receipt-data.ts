import { buildDecisionsRequest, parseDecisionsResponse, type Relation } from "../../../shared/receipt";
import raw from "../../../backend/test/fixtures/decisions.hand-extended.json";
import type { ReceiptRow } from "../../lib/parrot-judge-queue";
export const facts = "Wallet A is selected. No orders are placed.";
export function decision(claim: string, receipt = facts, relation: Relation = "faithful", support = 1, fact = .99) {
  const response = structuredClone(raw);
  const supportAnswer = response.answers.find(a => a.name === "supported_by_facts")!;
  supportAnswer.probability = support;
  response.answers.find(a => a.name === "states_a_fact")!.probability = fact;
  const answer = response.answers.find(a => a.name === "relation")!;
  answer.choice = relation;
  answer.probabilities = ["faithful", "contradicted", "unestablished", "ambiguous"].map(value => ({ value, probability: value === relation ? 1 : 0 }));
  return { ...parseDecisionsResponse(response), request: buildDecisionsRequest(claim, undefined, receipt), response, latencyMs: 400, costUsd: .00005 };
}
export function row(id = 1, relation: Relation = "faithful", support = 1, fact = .99): ReceiptRow {
  const claim = `Wallet sentence number ${id}.`;
  return { id, claim, facts, state: "done", decision: decision(claim, facts, relation, support, fact), roundTrip: 450 };
}
