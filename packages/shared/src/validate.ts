import {Ajv2020} from 'ajv/dist/2020.js';
import frame from '../schemas/candidate-curation-frame.schema.json' with {type:'json'};
import policy from '../schemas/bucket-policy.schema.json' with {type:'json'};
import role from '../schemas/role-consensus.schema.json' with {type:'json'};
import risk from '../schemas/risk-consensus.schema.json' with {type:'json'};
import red from '../schemas/redteam-consensus.schema.json' with {type:'json'};
import manifest from '../schemas/bucket-manifest.schema.json' with {type:'json'};
import report from '../schemas/rebalance-report.schema.json' with {type:'json'};
import type {SchemaName} from './contracts.ts';
const ajv = new Ajv2020({strict:true,allErrors:true});
const schemas = {'candidate-curation-frame':frame,'bucket-policy':policy,'role-consensus':role,'risk-consensus':risk,'redteam-consensus':red,'bucket-manifest':manifest,'rebalance-report':report};
const validators = Object.fromEntries(Object.entries(schemas).map(([name,schema])=>[name,ajv.compile(schema)]));
/** No coercion, removal of unknown keys, or invented defaults. */
export function validate(name: SchemaName, value: unknown): void {
  const validator = validators[name];
  if (!validator(value)) throw new Error(`${name}: ${ajv.errorsText(validator.errors)}`);
}
