import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {decodeAcceptanceArchive} from './github.mjs';
function zipOne(name, value) {
 const file=Buffer.from(name),content=Buffer.from(JSON.stringify(value)),compressed=deflateRawSync(content);
 const local=Buffer.alloc(30);
 local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(8,8);
 local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(content.length,22);
 local.writeUInt16LE(file.length,26);
 const central=Buffer.alloc(46);
 central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);
 central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(content.length,24);
 central.writeUInt16LE(file.length,28);central.writeUInt32LE(0,42);
 const directory=Buffer.concat([central,file]);
 const end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);
 end.writeUInt32LE(directory.length,12);
 end.writeUInt32LE(local.length+file.length+compressed.length,16);
 return Buffer.concat([local,file,compressed,directory,end]);
}
test('reads only a bounded exact artifact filename from a compressed Actions ZIP',()=>{
 const payload={run_id:10,head_sha:'abc',acceptance:[{id:'1',result:'passed'}]};
 assert.deepEqual(decodeAcceptanceArchive(zipOne('acceptance-proof.json',payload)),payload);
 assert.deepEqual(decodeAcceptanceArchive(zipOne('integration-proof.json',payload),'integration-proof.json'),payload);
 assert.throws(()=>decodeAcceptanceArchive(zipOne('fake.json',payload)),/Unexpected/);
});
test('truncated, empty and oversized archives are rejected',()=>{
 assert.throws(()=>decodeAcceptanceArchive(Buffer.alloc(0)),/Invalid/);
 const valid=zipOne('acceptance-proof.json',{a:1});
 assert.throws(()=>decodeAcceptanceArchive(valid.subarray(0,20)));
 assert.throws(()=>decodeAcceptanceArchive(Buffer.alloc(262145)),/Invalid/);
});
