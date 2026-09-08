import test from 'node:test';
import assert from 'node:assert/strict';
import {thumbnailFor,setThumbnailGenerator,revokeThumbnails} from '../web/thumbnails.js';

test('thumbnail cache returns one URL per entry and revokes on lock',async()=>{
  let calls=0;
  setThumbnailGenerator(async entry=>{calls++;return `blob:fake-${entry.id}`;});
  const entry={id:'a'.repeat(36),size:10,kind:'file',mime:'image/png',name:'a.png'};
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(calls,1);
  const other={...entry,id:'b'.repeat(36)};
  assert.equal(await thumbnailFor(other),`blob:fake-${'b'.repeat(36)}`);
  assert.equal(calls,2);
  revokeThumbnails();
  assert.equal(await thumbnailFor(entry),`blob:fake-${'a'.repeat(36)}`);
  assert.equal(calls,3);
  setThumbnailGenerator(null);
});
