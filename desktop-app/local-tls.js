const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const CERTIFICATE_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$certStore = 'Cert:\CurrentUser\My'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
# tlsDirectory is beneath Electron's per-user AppData directory, so retain its
# inherited Windows ACL rather than rewriting owner/DACL metadata. The root CA
# private key receives its own restrictive key-provider ACL below.
$keyAcl = [System.Security.AccessControl.FileSecurity]::new()
$keyAcl.SetAccessRuleProtection($true, $false)
$keyAcl.SetOwner($currentSid)
foreach ($sid in @($currentSid, $systemSid)) {
  $keyAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, [System.Security.AccessControl.InheritanceFlags]::None, [System.Security.AccessControl.PropagationFlags]::None, $allow))
}
$root = $null
$legacyRootThumbprint = $payload.previousRootThumbprint
if ($payload.rootThumbprint) {
  $root = Get-ChildItem -Path $certStore | Where-Object { $_.Thumbprint -eq $payload.rootThumbprint -and $_.HasPrivateKey }
}
if ($root -and $root.NotAfter -le (Get-Date).AddDays(30)) {
  Remove-Item -LiteralPath $root.PSPath -Force
  $root = $null
}
if (-not $root) {
  $root = New-SelfSignedCertificate -Type Custom -Subject 'CN=TETHER Local Root CA' -KeyAlgorithm ECDSA_nistP256 -KeyExportPolicy NonExportable -SecurityDescriptor $keyAcl -Provider 'Microsoft Software Key Storage Provider' -KeyUsage CertSign,CRLSign,DigitalSignature -KeyUsageProperty All -CertStoreLocation $certStore -NotAfter (Get-Date).AddYears(10) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0')
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
  $null = Export-PfxCertificate -Cert $leaf -FilePath $payload.serverPfxPath -Password $password -ChainOption BuildChain -CryptoAlgorithmOption AES256_SHA256
  $pfxData = Get-PfxData -FilePath $payload.serverPfxPath -Password $password
  $pfxThumbprints = @($pfxData.EndEntityCertificates + $pfxData.OtherCertificates | ForEach-Object { $_.Thumbprint })
  if ($leaf.Thumbprint -notin $pfxThumbprints -or $root.Thumbprint -notin $pfxThumbprints) {
    throw 'The temporary server PFX does not contain the expected leaf and CA chain.'
  }
  $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
  $chain.ChainPolicy.ExtraStore.Add($root) | Out-Null
  $chainBuilt = $chain.Build($leaf)
  $unexpectedChainErrors = @($chain.ChainStatus | Where-Object { $_.Status -ne [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::UntrustedRoot })
  $expectedUntrustedRootOnly = -not $chainBuilt -and $chain.ChainStatus.Count -eq 1 -and $chain.ChainStatus[0].Status -eq [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::UntrustedRoot
  $chainAccepted = $chainBuilt -or $expectedUntrustedRootOnly
  if (-not $chainAccepted -or $unexpectedChainErrors.Count -gt 0 -or $chain.ChainElements.Count -lt 2 -or $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint -ne $root.Thumbprint) {
    throw 'The issued server certificate did not chain to the persistent TETHER CA.'
  }
  $sanExtension = $leaf.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1
  $sanText = if ($sanExtension) { $sanExtension.Format($false) } else { '' }
  foreach ($address in $payload.addresses) {
    $sanPattern = '(?<![0-9.])' + [regex]::Escape($address) + '(?![0-9.])'
    if ($sanText -notmatch $sanPattern) { throw "The issued certificate SAN does not include $address." }
  }
  $hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $leafFingerprint = ([System.Security.Cryptography.X509Certificates.X509Certificate2]::new($leaf.RawData)).GetCertHashString($hash)
  $obsoleteRootThumbprint = $legacyRootThumbprint
  if (-not $obsoleteRootThumbprint -and $payload.rootThumbprint -and $payload.rootThumbprint -ne $root.Thumbprint) {
    $obsoleteRootThumbprint = $payload.rootThumbprint
  }
  if ($obsoleteRootThumbprint) {
    Get-ChildItem -Path $certStore | Where-Object { $_.Thumbprint -eq $obsoleteRootThumbprint } | Remove-Item -Force
  }
  [ordered]@{
    rootThumbprint = $root.Thumbprint
    rootNotAfter = $root.NotAfter.ToUniversalTime().ToString('o')
    leafFingerprint = $leafFingerprint
    leafNotAfter = $leaf.NotAfter.ToUniversalTime().ToString('o')
    subjectAlternativeNames = $sanText
  } | ConvertTo-Json -Compress | Write-Output
} finally {
  Remove-Item -LiteralPath (Join-Path $certStore $leaf.Thumbprint) -Force -ErrorAction SilentlyContinue
}
`;

function isPrivateIPv4Address(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4) return false;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function selectLanIPv4Address(networkInterfaces) {
  const candidates = [];
  for (const [name, interfaces] of Object.entries(networkInterfaces || {})) {
    for (const iface of interfaces || []) {
      if (!iface || iface.family !== 'IPv4' || iface.internal || net.isIP(iface.address) !== 4) continue;
      const adapterName = name.toLowerCase();
      const looksVirtual = /virtual|vethernet|vmware|virtualbox|hyper[- ]?v|wsl|docker|container|loopback|tailscale|wireguard|zerotier|\btap\b|\btun\b|bridge/i.test(adapterName);
      const looksPhysical = /wi[- ]?fi|wireless|ethernet|\blan\b|local area/i.test(adapterName);
      const score = (isPrivateIPv4Address(iface.address) ? 100 : 0) +
        (looksPhysical ? 20 : 0) -
        (looksVirtual ? 80 : 0) -
        (iface.address.startsWith('169.254.') ? 40 : 0);
      candidates.push({ address: iface.address, score, order: candidates.length });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.order - right.order);
  return candidates[0]?.address || '127.0.0.1';
}

function listLocalIPv4Addresses(networkInterfaces, preferredAddress) {
  const addresses = new Set(['127.0.0.1']);
  if (typeof preferredAddress === 'string' && net.isIP(preferredAddress) === 4) {
    addresses.add(preferredAddress);
  }
  for (const interfaces of Object.values(networkInterfaces || {})) {
    for (const iface of interfaces || []) {
      if (iface && iface.family === 'IPv4' && !iface.internal && net.isIP(iface.address) === 4) {
        addresses.add(iface.address);
      }
    }
  }
  return [...addresses].slice(0, 16);
}

function getPersistentRootThumbprint(storedThumbprint, securityVersion) {
  return typeof securityVersion === 'string' && securityVersion.trim() === '2'
    ? String(storedThumbprint || '').trim()
    : '';
}

function isLocalTlsMaterialCurrent(material, address, now = Date.now()) {
  if (!material || !Array.isArray(material.addresses) || !material.addresses.includes(address)) return false;
  const rootExpiry = Date.parse(material.rootNotAfter || '');
  const leafExpiry = Date.parse(material.leafNotAfter || '');
  return Number.isFinite(rootExpiry) && Number.isFinite(leafExpiry) &&
    rootExpiry > now + CERTIFICATE_RENEWAL_WINDOW_MS &&
    leafExpiry > now + CERTIFICATE_RENEWAL_WINDOW_MS;
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
        if (!result ||
            !/^[a-f0-9]{40}$/i.test(result.rootThumbprint || '') ||
            !/^[a-f0-9]{64}$/i.test(result.leafFingerprint || '') ||
            !Number.isFinite(Date.parse(result.rootNotAfter)) ||
            !Number.isFinite(Date.parse(result.leafNotAfter)) ||
            typeof result.subjectAlternativeNames !== 'string' ||
            result.subjectAlternativeNames.length === 0) {
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
  const rootSecurityVersionPath = path.join(tlsDirectory, 'root-security-version.txt');
  const rootThumbprint = await fs.promises.readFile(rootThumbprintPath, 'utf8').catch(() => '');
  const previousRootCertificate = await fs.promises.readFile(rootCertificatePath)
    .then((raw) => new crypto.X509Certificate(raw))
    .catch(() => null);
  const previousRootThumbprint = rootThumbprint.trim() ||
    previousRootCertificate?.fingerprint.replaceAll(':', '').toUpperCase() || '';
  const rootSecurityVersion = await fs.promises.readFile(rootSecurityVersionPath, 'utf8').catch(() => '');
  const persistentRootThumbprint = getPersistentRootThumbprint(rootThumbprint, rootSecurityVersion);
  const previousRootFingerprint = previousRootCertificate?.fingerprint256.replaceAll(':', '').toLowerCase() || '';
  const validAddresses = [...new Set((addresses || []).filter((address) => net.isIP(address) === 4))].slice(0, 16);
  const pfxPassphrase = crypto.randomBytes(32).toString('base64url');
  let metadata;
  try {
    metadata = await runPowerShell({
      rootThumbprint: persistentRootThumbprint,
      previousRootThumbprint: persistentRootThumbprint ? '' : previousRootThumbprint,
      tlsDirectory,
      rootCertificatePath,
      serverPfxPath,
      pfxPassphrase,
      addresses: validAddresses
    }, spawnProcess);
  } catch (error) {
    await fs.promises.rm(serverPfxPath, { force: true });
    throw error;
  }
  await fs.promises.writeFile(rootThumbprintPath, metadata.rootThumbprint, { mode: 0o600 });
  await fs.promises.writeFile(rootSecurityVersionPath, '2', { mode: 0o600 });

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
      leafFingerprint: metadata.leafFingerprint.replaceAll(':', '').toLowerCase(),
      rootNotAfter: metadata.rootNotAfter,
      leafNotAfter: metadata.leafNotAfter,
      subjectAlternativeNames: metadata.subjectAlternativeNames,
      certificateAuthorityRotated: Boolean(
        (previousRootFingerprint && previousRootFingerprint !== rootCertificate.fingerprint256.replaceAll(':', '').toLowerCase()) ||
        (rootThumbprint.trim() && rootThumbprint.trim().toUpperCase() !== metadata.rootThumbprint.toUpperCase())
      ),
      addresses: validAddresses
    };
  } finally {
    await fs.promises.rm(serverPfxPath, { force: true });
  }
}

module.exports = {
  POWERSHELL_SCRIPT,
  createLocalTlsMaterial,
  isPrivateIPv4Address,
  getPersistentRootThumbprint,
  isLocalTlsMaterialCurrent,
  listLocalIPv4Addresses,
  runPowerShell,
  selectLanIPv4Address
};
