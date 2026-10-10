import { chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMediaHost } from './network.ts';
import { XmaxProvider } from './provider.ts';
import { SecretBox, SessionStore } from './store.ts';
import { TryOnService } from './service.ts';
import { createApiServer } from './http.ts';
import { ExhibitionMirrors } from './exhibitionMirrors.ts';
import { MirrorCredentialStore } from './mirrorCredentials.ts';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environmentFile = resolve(root, process.env.OPENBUY_ENV_FILE ?? '.env');
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const dataDirectory = resolve(root, process.env.OPENBUY_DATA_DIR ?? '.data');
const secrets = SecretBox.forDirectory(dataDirectory);
const store = new SessionStore(`${dataDirectory}/sessions.sqlite`);
const provider = new XmaxProvider(process.env.XMAX_API_KEY ?? '');
if (provider.configured) store.activateApiKeyBudget(process.env.XMAX_API_KEY!);
const service = new TryOnService({
  provider, store, secrets, resolveHost: resolveMediaHost,
  mirrorCredentials: new MirrorCredentialStore(dataDirectory, secrets),
  perSessionLimit: Number(process.env.XMAX_SESSION_CREDITS ?? 30),
  expireSeconds: Number(process.env.XMAX_TOKEN_EXPIRE_SECONDS ?? 120),
});
const port = Number(process.env.OPENBUY_API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid internal API port');
const origins = (process.env.OPENBUY_ALLOWED_ORIGINS ?? [
  'http://xuminghong.local:10200', 'http://xuminghong.local:10201', 'https://xuminghong.local:10202',
  'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173',
].join(',')).split(',').map(value => value.trim()).filter(Boolean);
const exhibition = new ExhibitionMirrors(dataDirectory);
const server = createApiServer(service, origins, undefined, exhibition);
server.prependListener('request', (_request, response) => {
  response.setHeader('X-OpenBuy-Version', '1.1');
});
await service.recover();
server.listen(port, '127.0.0.1', () => {
  console.log(`Mirror internal API listening on port ${port} (XMAX ${provider.configured ? 'configured' : 'not configured'})`);
});
let sweeping = false;
const interval = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const row of store.list()) {
      if (!row.tokenCipher || !['active', 'stopping'].includes(row.status)) continue;
      try {
        const updated = await service.get(row.id);
        if (updated.status === 'stopping' || updated.consumedCredits >= updated.pointsLimit || (updated.expiresAt && Date.parse(updated.expiresAt) <= Date.now())) await service.stop(row.id);
      } catch { /* Retain unresolved revocation in SQLite for retry. */ }
    }
    await chmod(`${dataDirectory}/sessions.sqlite`, 0o600);
  } finally { sweeping = false; }
}, 5_000);
interval.unref();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(interval);
  server.close();
  await Promise.allSettled(store.list().filter(row => row.tokenCipher && row.status !== 'stopped').map(row => service.stop(row.id)));
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
