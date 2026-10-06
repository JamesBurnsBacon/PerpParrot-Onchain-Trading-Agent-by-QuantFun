import { resolve } from "node:path";
import type { FinalistLike } from "../../../shared/parrot-intent";

export const loadFinalists = async (): Promise<{ finalists: FinalistLike[]; dataSource: "sample" }> => ({
  finalists: await Bun.file(resolve(import.meta.dir, "../../fixtures/sample-finalists.json")).json() as FinalistLike[],
  dataSource: "sample",
});
