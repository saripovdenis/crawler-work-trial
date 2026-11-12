// Worker threads need their own TS loader registration. No network or database.
import { register } from 'tsx/esm/api';
register();
await import('./parse-worker.ts');
