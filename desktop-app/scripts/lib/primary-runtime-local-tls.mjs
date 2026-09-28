/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local integration fixture returns certificate file paths. */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)

export async function createPrimaryRuntimeLocalTls(root) {
  const directory = join(root, 'tls')
  const caKeyPath = join(directory, 'ca-key.pem')
  const caCertPath = join(directory, 'ca-cert.pem')
  const caConfigurationPath = join(directory, 'ca.cnf')
  const keyPath = join(directory, 'server-key.pem')
  const certificateRequestPath = join(directory, 'server.csr')
  const certPath = join(directory, 'server-cert.pem')
  const leafConfigurationPath = join(directory, 'server.cnf')
  await mkdir(directory, { recursive: true })
  // Keep this local-only test surface to one ephemeral trust anchor and one
  // loopback-only leaf. P3b verifies it through Electron Main's dedicated TLS
  // policy, rather than changing any process-wide or production trust
  // configuration.
  await writeFile(
    caConfigurationPath,
    [
      '[req]',
      'prompt=no',
      'distinguished_name=subject',
      'x509_extensions=v3_ca',
      '[subject]',
      'CN=DasCowork Primary Runtime P3b Test CA',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash'
    ].join('\n') + '\n',
    { mode: 0o600 }
  )
  await executeFile('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKeyPath,
    '-out',
    caCertPath,
    '-days',
    '1',
    '-config',
    caConfigurationPath,
    '-sha256'
  ])
  await executeFile('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certificateRequestPath,
    '-subj',
    '/CN=127.0.0.1'
  ])
  await writeFile(
    leafConfigurationPath,
    [
      '[v3_leaf]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=IP:127.0.0.1',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid:always,issuer:always'
    ].join('\n') + '\n',
    { mode: 0o600 }
  )
  await executeFile('openssl', [
    'x509',
    '-req',
    '-in',
    certificateRequestPath,
    '-CA',
    caCertPath,
    '-CAkey',
    caKeyPath,
    '-CAcreateserial',
    '-out',
    certPath,
    '-days',
    '1',
    '-sha256',
    '-extfile',
    leafConfigurationPath,
    '-extensions',
    'v3_leaf'
  ])
  await executeFile('openssl', ['verify', '-CAfile', caCertPath, certPath])
  return { keyPath, certPath, caPath: caCertPath }
}
