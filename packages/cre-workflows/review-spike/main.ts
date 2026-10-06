import {cre, Runner} from '@chainlink/cre-sdk';
import {configSchema, type SpikeConfig} from './wire.ts';
import {onReview} from './handler.ts';

export async function main() {
  const runner = await Runner.newRunner<SpikeConfig>({configSchema});
  await runner.run(config => [cre.handler(new cre.capabilities.CronCapability().trigger({schedule:config.schedule}), onReview)]);
}
await main();
