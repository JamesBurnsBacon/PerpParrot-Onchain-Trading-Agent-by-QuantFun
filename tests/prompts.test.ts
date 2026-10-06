import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PROMPT_VERSION,RED_TEAM_PROMPT,RISK_PROMPT,ROLE_PROMPT,promptHash} from '../packages/shared/src/prompts.ts';
// The doc is the reviewed source: each prompt is the preamble, a blank line, then the section,
// with each paragraph's line breaks joined by single spaces (SYSTEM_PROMPTS.md).
const doc=readFileSync(new URL('../docs/agents/SYSTEM_PROMPTS.md',import.meta.url),'utf8');
const sections=new Map(doc.split(/^## /m).slice(1).map(block=>{
  const newline=block.indexOf('\n');
  const paragraphs=block.slice(newline+1).trim().split('\n\n').map(p=>p.trim().split('\n').map(line=>line.trim()).join(' ')).filter(Boolean);
  return [block.slice(0,newline).trim(),paragraphs.join('\n\n')] as const;
}));
const preamble=sections.get('Shared preamble (prepend to each decision prompt)')!;
test('code prompts are byte-identical to SYSTEM_PROMPTS.md',()=>{
  assert.ok(doc.startsWith(`# Versioned system prompts v${PROMPT_VERSION}\n`));
  assert.equal(ROLE_PROMPT,`${preamble}\n\n${sections.get('Role Analyst')}`);
  assert.equal(RISK_PROMPT,`${preamble}\n\n${sections.get('Risk Auditor')}`);
  assert.equal(RED_TEAM_PROMPT,`${preamble}\n\n${sections.get('Red-Team Critic')}`);
});
test('prompts explain the frame 1.1.0 fields and hash distinctly',()=>{
  for(const prompt of [ROLE_PROMPT,RISK_PROMPT,RED_TEAM_PROMPT])for(const field of ['isSharpe','lookbackDays','scoreFlags','cloneCount'])assert.ok(prompt.includes(field),field);
  assert.equal(new Set([ROLE_PROMPT,RISK_PROMPT,RED_TEAM_PROMPT].map(promptHash)).size,3);
});
