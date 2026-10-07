// @env node
import {compatiblePaperCommittee} from './compatible-paper.ts';
import type {PaperModelOptions,PaperModelCore} from './types.ts';
/** Research-only K3 comparison; no production environment switch selects this adapter.
 * K3 always reasons and fixes sampling internally. Omit temperature/top_p rather than
 * copying OpenAI's non-reasoning parameters. The shared validator remains fail-closed. */
export function kimiPaperCommittee(options:PaperModelOptions,core:PaperModelCore){
  if(options.model!=='kimi-k3')throw new Error('invalid Kimi paper model');
  if(options.endpoint&&options.endpoint!=='https://api.moonshot.cn/v1/chat/completions')throw new Error('invalid Kimi endpoint');
  return compatiblePaperCommittee(options,core,{provider:'moonshot',endpoint:'https://api.moonshot.cn/v1/chat/completions',
    generation:{reasoning_effort:'high',max_completion_tokens:32768},
  });
}
