import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { requestJson, requestMultipartJson } from '../server/network.mjs';

test('model requests identify the client to gateways without altering authorization or payload',async t=>{
  let captured;
  t.mock.method(https,'request',(url,options,callback)=>{
    const request=new EventEmitter();let payload='';
    request.write=chunk=>{payload+=chunk};request.destroy=()=>{};
    request.end=()=>{captured={url,options,payload};queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;response.headers={};callback(response);response.emit('data',Buffer.from('{"ok":true}'));response.emit('end');});};
    return request;
  });
  const response=await requestJson('https://provider.example/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-fixture'},body:{model:'qwen3.7-plus'},lookup:async()=>[{address:'8.8.8.8',family:4}]});
  assert.deepEqual(response,{ok:true});
  assert.equal(captured.options.headers['User-Agent'],'AIFrameStudio/0.1');
  assert.equal(captured.options.headers.Authorization,'Bearer test-fixture');
  assert.equal(captured.options.method,'POST');
  assert.equal(captured.payload,'{"model":"qwen3.7-plus"}');
});

test('multipart requests preserve fields, file bytes, and bearer authorization', async t => {
  let captured;
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter();
    const chunks = [];
    request.write = chunk => chunks.push(Buffer.from(chunk));
    request.destroy = () => {};
    request.end = () => {
      captured = { url, options, payload: Buffer.concat(chunks) };
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; callback(response);
        response.emit('data', Buffer.from('{"url":"https://cdn.example/reference.png"}')); response.emit('end');
      });
    };
    return request;
  });
  const response = await requestMultipartJson('https://provider.example/v1/files', {
    headers: { Authorization: 'Bearer multipart-fixture' },
    fields: { purpose: 'video' },
    file: { filename: 'reference.png', contentType: 'image/png', data: Buffer.from([0, 1, 2, 3]) },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  });
  assert.deepEqual(response, { url: 'https://cdn.example/reference.png' });
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer multipart-fixture');
  assert.match(captured.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  assert.match(captured.payload.toString('utf8'), /name="purpose"\r\n\r\nvideo/);
  assert.match(captured.payload.toString('utf8'), /filename="reference\.png"/);
  assert.notEqual(captured.payload.indexOf(Buffer.from([0, 1, 2, 3])), -1);
});
