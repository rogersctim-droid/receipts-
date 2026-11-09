import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, buildZip } from '../src/zip.js';

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip structure has local header, central directory and EOCD', () => {
  const data = new TextEncoder().encode('hello');
  const zip = buildZip([{ name: 'a.txt', data, date: new Date(2026, 0, 1) }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 1, 'one entry');
  const cdOffset = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cdOffset, true), 0x02014b50);
  assert.equal(dv.getUint32(14, true), crc32(data));
});
