// Test-only preload: never imported by a production entry point.
import net from 'node:net';
import { responseFor } from './responses.cjs';
net.Socket.prototype.connect = function () { throw new Error('Simulator blocked a real network connection'); };
globalThis.fetch = async input => {
  const response = responseFor(String(input));
  return new Response(response.body, { status: response.status, headers: response.headers });
};
