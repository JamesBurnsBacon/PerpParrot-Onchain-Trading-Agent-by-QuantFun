// @env node
import {compatiblePaperCommittee} from './compatible-paper.ts';
import type {PaperModelOptions,PaperModelCore} from './types.ts';
const modelPattern=/^gpt-[A-Za-z0-9.-]+-\d{4}-\d{2}-\d{2}$/;
/** The production adapter retains its existing parameters and modelConfigHash. */
export function openAIPaperCommittee(options:PaperModelOptions,core:PaperModelCore){
  const sol=options.model==='gpt-6-sol';
  if(!sol&&!modelPattern.test(options.model))throw new Error('invalid paper model configuration');
  return compatiblePaperCommittee(options,core,{provider:'openai',endpoint:'https://api.openai.com/v1/chat/completions',
    generation:sol?{reasoning_effort:'high',max_completion_tokens:32768}:{temperature:0,max_completion_tokens:8192},
    ...(!sol?{hashGeneration:{temperature:0}}:{}),
  });
}
