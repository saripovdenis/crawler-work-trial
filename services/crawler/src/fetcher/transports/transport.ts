import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { domainFor } from '../../../../../packages/core/src/policy.js';

// All subdomains use the configured domain transport and budget.
import { policy } from '../../../../../config/site-policy.js';
export const usesChromeProfile = (url: string) => policy.for(domainFor(url) || '')?.transport === 'chrome136';
export const USER_AGENT = 'ExaTrialCrawler/0.1';

export async function fetchResponse(url: string, headers: Record<string, string>, signal: AbortSignal, dispatch?: { transport: 'node' | 'chrome136'; start_by: string }): Promise<Response> {
  if (dispatch && Date.now() > Date.parse(dispatch.start_by)) throw new Error('Dispatch deadline expired');
  if (!(dispatch ? dispatch.transport === 'chrome136' : usesChromeProfile(url))) return fetch(url, {
    redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml,application/rss+xml,*/*;q=0.5', ...headers },
  });
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.CRAWLER_PYTHON || 'python3',
      [fileURLToPath(new URL('../../../../fetcher-impersonate/cffi-fetch.py', import.meta.url))],
      { signal, timeout: 25_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error);
        try {
          const result = JSON.parse(stdout);
          if (result.error) throw new Error(`curl_cffi: ${result.error}`);
          if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string')
            throw new Error('Invalid curl_cffi response');
          const bytes = Buffer.from(result.body, 'base64');
          if (bytes.length > 5 * 1024 * 1024) throw new Error('Response exceeds 5 MiB');
          resolve(new Response([204, 205, 304].includes(result.status) ? null : new Uint8Array(bytes), {
            status: result.status, headers: result.headers,
          }));
        } catch (e) { reject(e); }
      });
    child.stdin?.on('error', () => {}); // Child failure is reported by execFile.
    child.stdin?.end(JSON.stringify({ url, profile: 'cffi-chrome', headers, start_by: dispatch?.start_by }));
  });
}
