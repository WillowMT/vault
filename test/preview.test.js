import test from 'node:test';
import assert from 'node:assert/strict';
import {pdfPreviewMode} from '../web/preview.js';

test('pdf preview uses an iframe except in Safari-like browsers',()=>{
  assert.equal(pdfPreviewMode('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'),'tab');
  assert.equal(pdfPreviewMode('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'),'tab');
  assert.equal(pdfPreviewMode('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'),'frame');
  assert.equal(pdfPreviewMode('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 Fxios/126.0'),'frame');
  assert.equal(pdfPreviewMode('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Edg/126.0'),'frame');
  assert.equal(pdfPreviewMode('Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0'),'frame');
});
