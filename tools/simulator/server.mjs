import { createServer } from 'node:http';
import { responseFor } from './responses.cjs';
const server = createServer((req, res) => {
  const response = responseFor(new URL(req.url, 'http://127.0.0.1').href);
  res.writeHead(response.status, response.headers); res.end(response.body);
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log(`Simulator: http://127.0.0.1:${server.address().port}`));
for (const event of ['SIGINT','SIGTERM']) process.on(event, () => server.close());
