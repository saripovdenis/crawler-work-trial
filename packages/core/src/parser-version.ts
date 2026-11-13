import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Source and dependency changes invalidate saved extraction and mapping results.
const hash=createHash('sha256').update('extraction-cache-v1');
for(const path of ['./parse.ts','./discovery-api.ts','./policy.ts','./extraction-cache.ts','../../../config/discovery.ts','../../../config/sites.ts','../../../config/profiles.ts','../../../package-lock.json'])
  hash.update(readFileSync(new URL(path,import.meta.url)));
export const PARSER_VERSION=hash.digest('hex');
