const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$certStore = 'Cert:\CurrentUser\My'
$root = $null
if ($payload.rootThumbprint) {
  $root = Get-ChildItem -Path $certStore | Where-Object { $_.Thumbprint -eq $payload.rootThumbprint -and $_.HasPrivateKey }
}
if (-not $root) {
  $root = New-SelfSignedCertificate -Type Custom -Subject 'CN=TETHER Local Root CA' -KeyAlgorithm ECDSA_nistP256 -KeyUsage CertSign,CRLSign,DigitalSignature -KeyUsageProperty All -CertStoreLocation $certStore -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
}
$addresses = @('127.0.0.1', '::1') + @($payload.addresses)
$san = 'DNS=localhost'
foreach ($address in ($addresses | Select-Object -Unique)) { $san += '&IPAddress=' + $address }
$leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=TETHER Local Server' -Signer $root -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -CertStoreLocation $certStore -NotAfter (Get-Date).AddDays(397) -TextExtension @("2.5.29.17={text}$san", '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
try {
  if (Test-Path -LiteralPath $payload.rootCertificatePath) { Remove-Item -LiteralPath $payload.rootCertificatePath -Force }
  if (Test-Path -LiteralPath $payload.serverPfxPath) { Remove-Item -LiteralPath $payload.serverPfxPath -Force }
  $null = Export-Certificate -Cert $root -FilePath $payload.rootCertificatePath -Type CERT
  $password = ConvertTo-SecureString -String $payload.pfxPassphrase -Force -AsPlainText
  $null = Export-PfxCertificate -Cert $leaf -FilePath $payload.serverPfxPath -Password $password -ChainOption BuildChain
  $hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $leafFingerprint = ([System.Security.Cryptography.X509Certificates.X509Certificate2]::new($leaf.RawData)).GetCertHashString($hash)
  [ordered]@{ rootThumbprint = $root.Thumbprint; leafFingerprint = $leafFingerprint } | ConvertTo-Json -Compress | Write-Output
} finally {
  Remove-Item -LiteralPath (Join-Path $certStore $leaf.Thumbprint) -Force -ErrorAction SilentlyContinue
}
`;

function listLocalIPv4Addresses(networkInterfaces) {
  const addresses = new Set(['127.0.0.1']);
  for (const interfaces of Object.values(networkInterfaces || {})) {
    for (const iface of interfaces || []) {
      if (iface && iface.family === 'IPv4' && !iface.internal && net.isIP(iface.address) === 4) {
        addresses.add(iface.address);
      }
    }
  }
  return [...addresses].slice(0, 16);
}

function runPowerShell(payload, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const encodedScript = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawnProcess(powershellPath, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(['SystemRoot', 'WINDIR', 'USERPROFILE', 'PSModulePath', 'TEMP', 'TMP']
        .filter((name) => typeof process.env[name] === 'string')
        .map((name) => [name, process.env[name]]))
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Local certificate setup timed out.'));
    }, 30000);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(new Error(`Could not start Windows certificate setup: ${error.code || error.name}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(`Windows certificate setup failed (${code}): ${stderr.trim().slice(-600)}`));
        return;
      }
      try {
        const resultLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        const result = JSON.parse(resultLine || 'null');
        if (!result || typeof result.rootThumbprint !== 'string' || typeof result.leafFingerprint !== 'string') {
          throw new Error('Certificate setup returned invalid metadata.');
        }
        finish(null, result);
      } catch (error) {
        finish(new Error(`Could not read Windows certificate setup result: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function createLocalTlsMaterial({ userDataPath, addresses, spawnProcess }) {
  if (process.platform !== 'win32') {
    throw new Error('Secure local pairing currently requires Windows certificate services.');
  }
  const tlsDirectory = path.join(userDataPath, 'tls');
  await fs.promises.mkdir(tlsDirectory, { recursive: true });
  const rootCertificatePath = path.join(tlsDirectory, 'tether-local-root.cer');
  const serverPfxPath = path.join(tlsDirectory, 'tether-local-server.pfx');
  const rootThumbprintPath = path.join(tlsDirectory, 'root-thumbprint.txt');
  const rootThumbprint = await fs.promises.readFile(rootThumbprintPath, 'utf8').catch(() => '');
  const pfxPassphrase = crypto.randomBytes(32).toString('base64url');
  let metadata;
  try {
    metadata = await runPowerShell({
      rootThumbprint: rootThumbprint.trim(),
      rootCertificatePath,
      serverPfxPath,
      pfxPassphrase,
      addresses: (addresses || []).filter((address) => net.isIP(address) === 4).slice(0, 16)
    }, spawnProcess);
  } catch (error) {
    await fs.promises.rm(serverPfxPath, { force: true });
    throw error;
  }
  await fs.promises.writeFile(rootThumbprintPath, metadata.rootThumbprint, { mode: 0o600 });

  try {
    const rootCertificate = new crypto.X509Certificate(await fs.promises.readFile(rootCertificatePath));
    const spki = rootCertificate.publicKey.export({ type: 'spki', format: 'der' });
    const certificatePin = `sha256/${crypto.createHash('sha256').update(spki).digest('base64')}`;
    const pfx = await fs.promises.readFile(serverPfxPath);
    return {
      pfx,
      pfxPassphrase,
      rootCertificatePath,
      rootFingerprint: rootCertificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      certificatePin,
      leafFingerprint: metadata.leafFingerprint.replaceAll(':', '').toLowerCase()
    };
  } finally {
    await fs.promises.rm(serverPfxPath, { force: true });
  }
}

module.exports = { createLocalTlsMaterial, listLocalIPv4Addresses, runPowerShell };
