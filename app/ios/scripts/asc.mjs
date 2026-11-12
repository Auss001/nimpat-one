// Talks to Apple (App Store Connect API) for iPhone signing. Used only by the GitHub workflows. Prints no secret.
//   node asc.mjs make-cert <csr.pem> <out.cer>             asks Apple for one distribution certificate
//   node asc.mjs profile <certSerial> <bundleId> <outDir>  finds or makes the App Store profile for that certificate;
//                                                          saves it as <outDir>/<uuid>.mobileprovision and prints NAME=… and UUID=…
// Needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (the .p8 file) in the environment.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const PROFILE_NAME = 'Nimpat One App Store (GitHub)';
const b64u = (v) => Buffer.from(v).toString('base64url');

function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const key = createPrivateKey(readFileSync(process.env.ASC_KEY_PATH));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

async function api(method, path, data) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify({ data }) : undefined,
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (json.errors ?? []).map((e) => e.detail ?? e.title).join(' ') || `HTTP ${res.status}`;
    throw new Error(`Apple said: ${why}`);
  }
  return json;
}

const sameSerial = (a, b) => a.replace(/^0+/, '').toUpperCase() === b.replace(/^0+/, '').toUpperCase();

async function makeCert(csrPath, outPath) {
  const made = await api('POST', '/certificates', {
    type: 'certificates',
    attributes: { certificateType: 'DISTRIBUTION', csrContent: readFileSync(csrPath, 'utf8') },
  });
  writeFileSync(outPath, Buffer.from(made.data.attributes.certificateContent, 'base64'));
  console.log(`Certificate made. It is valid until ${made.data.attributes.expirationDate.slice(0, 10)}.`);
}

async function profile(serial, bundle, outDir) {
  const certs = await api('GET', '/certificates?limit=200');
  const cert = certs.data.find((c) => sameSerial(c.attributes.serialNumber, serial));
  if (!cert) throw new Error('The saved certificate is no longer in the Apple account (revoked or expired). Run app/ios/scripts/make-cert.sh again and update the two secrets.');
  const ids = await api('GET', `/bundleIds?filter[identifier]=${encodeURIComponent(bundle)}&limit=200`);
  const bundleId = ids.data.find((b) => b.attributes.identifier === bundle);
  if (!bundleId) throw new Error(`The app ID ${bundle} is not in the Apple account.`);

  const found = await api('GET', `/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&include=certificates&limit=50`);
  let use = null;
  for (const p of found.data.filter((x) => x.attributes.name === PROFILE_NAME)) {
    const hasCert = (p.relationships?.certificates?.data ?? []).some((c) => c.id === cert.id);
    if (!use && p.attributes.profileState === 'ACTIVE' && hasCert) use = p;
    else await api('DELETE', `/profiles/${p.id}`); // out of date: made for an older certificate, or no longer valid
  }
  if (!use) {
    use = (await api('POST', '/profiles', {
      type: 'profiles',
      attributes: { name: PROFILE_NAME, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleId.id } },
        certificates: { data: [{ type: 'certificates', id: cert.id }] },
      },
    })).data;
    console.log('Profile made.');
  } else console.log('Profile already there.');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${use.attributes.uuid}.mobileprovision`, Buffer.from(use.attributes.profileContent, 'base64'));
  console.log(`NAME=${use.attributes.name}`);
  console.log(`UUID=${use.attributes.uuid}`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = cmd === 'make-cert' ? makeCert(...args) : cmd === 'profile' ? profile(...args) : Promise.reject(new Error('Unknown command'));
run.catch((e) => { console.error(e.message); process.exit(1); });
