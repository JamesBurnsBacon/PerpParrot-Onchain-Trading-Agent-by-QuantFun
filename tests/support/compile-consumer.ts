import {readFileSync} from 'node:fs';
import solc from 'solc';
export function compileConsumer(){
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'FrozenMirrorConsumer.sol':{content:readFileSync(new URL('../../packages/contracts/src/FrozenMirrorConsumer.sol',import.meta.url),'utf8')}},settings:{optimizer:{enabled:true,runs:200},evmVersion:'shanghai',outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}})));
  if(output.errors?.some((error:{severity:string})=>error.severity==='error'))throw new Error(JSON.stringify(output.errors));
  return output.contracts['FrozenMirrorConsumer.sol'].FrozenMirrorConsumer;
}
