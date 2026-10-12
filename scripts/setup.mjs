import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'selfsigned';
import { HOSTNAME, isPrivateAddress } from './gateway-shared.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const minimumNode = () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('请安装 Node.js 22.13 或更新版本，建议 Node.js 24。');
};
const expires = days => new Date(Date.now() + days * 86_400_000);

export async function prepareCertificates(root = projectRoot) {
  const directory = resolve(root, '.data/lan-tls');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = resolve(directory, 'root-ca.key');
  const caCert = resolve(directory, 'root-ca.crt');
  if (existsSync(caKey) !== existsSync(caCert)) throw new Error('本地 CA 不完整，请恢复 .data/lan-tls 的证书和私钥后重试。');
  let ca;
  if (existsSync(caKey)) {
    ca = { key: await readFile(caKey, 'utf8'), cert: await readFile(caCert, 'utf8') };
    const certificate = new X509Certificate(ca.cert);
    if (!certificate.ca || !certificate.checkPrivateKey(createPrivateKey(ca.key)) || Date.parse(certificate.validTo) <= Date.now()) {
      throw new Error('本地 CA 无效或已过期，请恢复有效的 CA；初始化不会覆盖已有信任。');
    }
  } else {
    const generated = await generate([{ name: 'commonName', value: 'OpenBuy Exhibition Local CA' }], {
      algorithm: 'sha256', keySize: 2048, notAfterDate: expires(3650),
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    ca = { key: generated.private, cert: generated.cert };
    await writeFile(caKey, ca.key, { mode: 0o600, flag: 'wx' });
    await writeFile(caCert, ca.cert, { mode: 0o600, flag: 'wx' });
  }
  const ips = Object.values(networkInterfaces()).flatMap(value => value ?? [])
    .filter(value => value.family === 'IPv4' && isPrivateAddress(value.address))
    .map(value => value.address);
  const hosts = [...new Set([HOSTNAME, 'localhost'])];
  const addresses = [...new Set(['127.0.0.1', ...ips])];
  const serverKey = resolve(directory, 'server.key');
  const serverCert = resolve(directory, 'server.crt');
  let renew = true;
  if (existsSync(serverKey) && existsSync(serverCert)) {
    try {
      const certificate = new X509Certificate(await readFile(serverCert));
      renew = !(certificate.checkPrivateKey(createPrivateKey(await readFile(serverKey)))
        && certificate.verify(new X509Certificate(ca.cert).publicKey)
        && Date.parse(certificate.validTo) > Date.now() + 30 * 86_400_000
        && hosts.every(host => certificate.checkHost(host)) && addresses.every(ip => certificate.checkIP(ip)));
    } catch { /* Reissue the leaf while retaining the CA. */ }
  }
  if (renew) {
    const generated = await generate([{ name: 'commonName', value: HOSTNAME }], {
      algorithm: 'sha256', keySize: 2048, notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: expires(365), ca,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [
          ...hosts.map(value => ({ type: 2, value })), ...addresses.map(ip => ({ type: 7, ip })),
        ] },
      ],
    });
    const leaf = new X509Certificate(generated.cert);
    if (!leaf.verify(new X509Certificate(ca.cert).publicKey) || !leaf.checkPrivateKey(createPrivateKey(generated.private))) throw new Error('证书生成校验失败。');
    const staging = resolve(directory, `staging-${process.pid}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      await writeFile(resolve(staging, 'server.key'), generated.private, { mode: 0o600 });
      await writeFile(resolve(staging, 'server.crt'), generated.cert, { mode: 0o600 });
      if (existsSync(serverKey) || existsSync(serverCert)) {
        const backup = resolve(directory, 'backups', String(Date.now()));
        await mkdir(backup, { recursive: true, mode: 0o700 });
        for (const name of ['server.key', 'server.crt']) if (existsSync(resolve(directory, name))) await copyFile(resolve(directory, name), resolve(backup, name));
      }
      await rename(resolve(staging, 'server.key'), serverKey);
      await rename(resolve(staging, 'server.crt'), serverCert);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await mkdir(resolve(root, 'public'), { recursive: true });
  await copyFile(caCert, resolve(root, 'public/openbuy-local-ca.crt'));
  return { renewed: renew, hosts, addresses };
}

export async function setup({ root = projectRoot, certificateOnly = false, empty = false } = {}) {
  minimumNode();
  const environment = resolve(root, '.env');
  if (!certificateOnly) {
    if (!existsSync(environment)) await writeFile(environment, await readFile(resolve(root, '.env.example')), { mode: 0o600, flag: 'wx' });
    process.loadEnvFile(environment);
    if (!empty) {
      const { seedMaterials } = await import('./seed-materials.mjs');
      const result = await seedMaterials({ dataDirectory: resolve(root, process.env.OPENBUY_DATA_DIR ?? '.data') });
      console.log(result.installed ? '展会素材已初始化。' : '保留已有展会数据。');
    }
  }
  const result = await prepareCertificates(root);
  console.log(result.renewed ? '摄像头 HTTPS 证书已生成。' : '摄像头 HTTPS 证书已核验。');
  console.log('初始化完成。运行 npm start；摄像头设备首次使用需信任 .data/lan-tls/root-ca.crt。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup({ certificateOnly: process.argv.includes('--certificate-only'), empty: process.argv.includes('--empty') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
