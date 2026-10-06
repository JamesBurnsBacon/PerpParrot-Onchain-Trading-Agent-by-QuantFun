import {
  cre, ConsensusAggregationByFields, median, bytesToBase64,
  type Runtime, type HTTPSendRequester,
} from '@chainlink/cre-sdk';
import {commitment} from '../../shared/src/commitments.ts';
import {configSchema, requestBody, parseProviderResponse, validateEvidence, validateAggregatedScores, byteLength, FIELDS, PROMPT_HASH, type SpikeConfig} from './wire.ts';

/** Deliberately no report(), chain write, executor endpoint, cache or execution mode. */
export function onReview(runtime: Runtime<SpikeConfig>) {
  const config = configSchema.parse(runtime.config);
  const evidence = validateEvidence(config.evidence);
  const ids = evidence.finalists.map(f => f.candidate);
  const modelConfigHash = commitment('perpparrot:model:v1', {model:config.model, temperature:0, promptHash:PROMPT_HASH});
  const apiKey = runtime.getSecret({id:config.secretId}).result().value;
  if (!apiKey || apiKey.length > 2048 || /[\r\n]/.test(apiKey)) throw new Error('invalid provider credential');
  const body = bytesToBase64(new TextEncoder().encode(JSON.stringify(requestBody(config))));
  const request = {
    url:'https://api.openai.com/v1/chat/completions', method:'POST', body,
    multiHeaders:{'Content-Type':{values:['application/json']}, Authorization:{values:[`Bearer ${apiKey}`]}},
    timeout:'10s',
  };
  // Bound the full base64 request envelope, not only the finalist JSON.
  if (byteLength(request) > 115_000) throw new Error('encoded HTTP request exceeds reserved budget');
  const fields = Object.fromEntries(ids.flatMap(id => FIELDS.map(field => [`c${id}_${field}`, median<number>])));
  const fetchScores = (requester: HTTPSendRequester): Record<string, number> => {
    const response = requester.sendRequest(request).result();
    if (response.statusCode !== 200) throw new Error(`provider HTTP status ${response.statusCode}`);
    return parseProviderResponse(response.body, ids);
  };
  const scores = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, fetchScores, ConsensusAggregationByFields<Record<string, number>>(fields))()
    .result();
  validateAggregatedScores(scores, ids);
  const result = {
    mode:'SIMULATION', economicAuthority:false,
    asOfMs:runtime.now().getTime(), inputHash:commitment('perpparrot:spike-input:v1', evidence),
    promptHash:PROMPT_HASH, modelConfigHash, scores,
  };
  runtime.log(`review spike completed; model=${config.model}; candidates=${ids.length}; numeric consensus validated`);
  return result;
}
