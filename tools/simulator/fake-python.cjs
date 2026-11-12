#!/usr/bin/env node
// Python-shaped offline subprocess fixture. It performs no network requests.
const { responseFor } = require('./responses.cjs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const response = responseFor(JSON.parse(input).url);
  console.log(JSON.stringify({ ...response, body: Buffer.from(response.body).toString('base64'), version: 'simulator', impersonate: 'chrome136', httpVersion: 3 }));
});
