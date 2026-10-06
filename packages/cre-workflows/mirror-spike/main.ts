import {cre,Runner} from '@chainlink/cre-sdk';
import {mirrorConfigSchema,type MirrorConfig} from './wire.ts';
import {onMirror} from './handler.ts';
export async function main(){const runner=await Runner.newRunner<MirrorConfig>({configSchema:mirrorConfigSchema});await runner.run(config=>[cre.handler(new cre.capabilities.CronCapability().trigger({schedule:config.schedule}),onMirror)]);}
await main();
