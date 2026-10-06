import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keccak_256} from '@noble/hashes/sha3.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {commitment,policyCommitment,snapshotCommitment,verifyInputCommitments} from '../packages/shared/src/commitments.ts';
import type {Frame,Policy} from '../packages/shared/src/contracts.ts';
test('Keccak matches the published empty-input vector (not SHA3-256)',()=>{
  assert.equal(bytesToHex(keccak_256(new Uint8Array())), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});
test('commitments are stable across object insertion order and domain-separated',()=>{
  assert.equal(commitment('perpparrot:policy:v1',{b:2,a:1}),commitment('perpparrot:policy:v1',{a:1,b:2}));
  assert.notEqual(commitment('perpparrot:policy:v1',{a:1}),commitment('perpparrot:draft:v1',{a:1}));
  assert.notEqual(commitment('perpparrot:policy:v1',{a:1}),commitment('perpparrot:policy:v1',{a:2}));
});
test('canonical encoder rejects values JSON.stringify would drop/coerce',()=>{
  for(const value of [NaN,Infinity,undefined,BigInt(1),new Date(),{a:undefined},'\ud800',Array(1)])assert.throws(()=>commitment('perpparrot:policy:v1',value));
  const cyclic: Record<string,unknown>={};cyclic.self=cyclic;assert.throws(()=>commitment('perpparrot:policy:v1',cyclic));
});
test('policy, evidence and candidate-to-address mapping are committed together',()=>{
  const policy={bucket:'BALANCED',capitalUsd:150} as Policy;
  const frame={schemaVersion:'1.0.0',snapshotHash:'',policyHash:policyCommitment(policy),candidates:[],pairs:[],asOfMs:1,expiresAtMs:2} as Frame;
  const addresses=new Map([[0,'0x'+'a'.repeat(40)],[1,'0x'+'b'.repeat(40)]]);
  frame.snapshotHash=snapshotCommitment(frame,addresses);
  assert.ok(verifyInputCommitments(frame,policy,addresses));
  assert.equal(snapshotCommitment(frame,addresses),snapshotCommitment(frame,new Map([...addresses].reverse())));
  assert.ok(!verifyInputCommitments({...frame,asOfMs:0},policy,addresses));
  assert.ok(!verifyInputCommitments(frame,{...policy,capitalUsd:200},addresses));
  assert.ok(!verifyInputCommitments(frame,policy,new Map([[0,'0x'+'b'.repeat(40)],[1,'0x'+'a'.repeat(40)]])));
});
