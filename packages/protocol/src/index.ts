export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DISPATCH_MS = 5_000;
export const LEASE_MS = 60_000;
export type Assignment = {
  task_id: string; attempt_id: string; lease_token: string; domain: string; url: string;
  purpose: string; transport: 'node' | 'chrome136'; headers: Record<string,string>;
  timeout_ms: number; max_response_bytes: number; start_by: string; lease_until: string;
};
export type Claim = { task: Assignment | null; retry_after_ms?: number };
export type Completion = {
  lease_token: string; started_at: string | null; finished_at: string;
  status: number | null; headers: Record<string,string>; body_hash: string | null;
  response_ref: string | null; bytes: number; error: string | null;
};
