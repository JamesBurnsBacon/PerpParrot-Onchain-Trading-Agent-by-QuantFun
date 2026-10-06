import schema from '../schemas/bucket-policy.schema.json' with {type:'json'};
import type {Policy} from './contracts.ts';
interface Rule {type?:string;enum?:unknown[];const?:unknown;minimum?:number;maximum?:number;exclusiveMinimum?:number}
/** Interprets this flat policy schema without eval/code generation in CRE. */
export function validateRuntimePolicy(value:unknown):asserts value is Policy {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid policy');
  const input=value as Record<string,unknown>,properties=schema.properties as Record<string,Rule>;
  if(Object.keys(input).sort().join(',')!==schema.required.slice().sort().join(','))throw new Error('unknown or missing policy fields');
  for(const [name,rule] of Object.entries(properties).sort(([a],[b])=>a<b?-1:a>b?1:0)){
    if(Object.keys(rule).sort().some(key=>!['type','enum','const','minimum','maximum','exclusiveMinimum'].includes(key))||rule.type!==undefined&&!['number','integer'].includes(rule.type))throw new Error('unsupported runtime policy schema');
    const v=input[name];
    if(rule.enum&&!rule.enum.includes(v)||Object.hasOwn(rule,'const')&&v!==rule.const)throw new Error('invalid policy value');
    if(rule.type==='number'||rule.type==='integer'){
      if(typeof v!=='number'||!Number.isFinite(v)||rule.type==='integer'&&!Number.isSafeInteger(v)||rule.minimum!==undefined&&v<rule.minimum||rule.maximum!==undefined&&v>rule.maximum||rule.exclusiveMinimum!==undefined&&v<=rule.exclusiveMinimum)throw new Error('invalid policy number');
    }
  }
}
