const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  POWERSHELL_SCRIPT,
  getPersistentRootThumbprint,
  isPrivateIPv4Address,
  isLocalTlsMaterialCurrent,
  listLocalIPv4Addresses,
  selectLanIPv4Address
} = require('../local-tls');

test('Windows CA key policy is persistent, non-exportable, and limited by a private ACL', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'local-tls.js'), 'utf8');
  assert.match(source, /root-security-version\.txt/);
  assert.match(source, /getPersistentRootThumbprint\(rootThumbprint, rootSecurityVersion\)/);
  assert.match(source, /rootNotAfter/);
  assert.match(source, /leafNotAfter/);
  assert.match(POWERSHELL_SCRIPT, /Cert:\\CurrentUser\\My/);
  assert.match(POWERSHELL_SCRIPT, /KeyExportPolicy NonExportable/);
  assert.match(POWERSHELL_SCRIPT, /SecurityDescriptor \$keyAcl/);
  assert.match(POWERSHELL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(POWERSHELL_SCRIPT, /inherited Windows ACL rather than rewriting owner\/DACL metadata/);
  assert.doesNotMatch(POWERSHELL_SCRIPT, /(?:Set-Acl|icacls\.exe).*tlsDirectory/);
  assert.match(POWERSHELL_SCRIPT, /Export-PfxCertificate.*CryptoAlgorithmOption AES256_SHA256/);
  assert.match(POWERSHELL_SCRIPT, /Get-PfxData/);
  assert.match(POWERSHELL_SCRIPT, /Export-Certificate -Cert \$root .* -Type CERT/);
  assert.match(POWERSHELL_SCRIPT, /\$root = Get-ChildItem -Path \$certStore .* -and \$_.HasPrivateKey/);
  assert.match(POWERSHELL_SCRIPT, /New-SelfSignedCertificate .* -Signer \$root/);
  assert.match(POWERSHELL_SCRIPT, /Export-PfxCertificate -Cert \$leaf/);
  assert.match(POWERSHELL_SCRIPT, /ChainPolicy\.ExtraStore\.Add\(\$root\)/);
  assert.match(POWERSHELL_SCRIPT, /chain\.ChainElements\[\$chain\.ChainElements\.Count - 1\].Certificate\.Thumbprint -ne \$root\.Thumbprint/);
  assert.match(POWERSHELL_SCRIPT, /foreach \(\$address in \$payload\.addresses\)/);
  assert.match(POWERSHELL_SCRIPT, /leafNotAfter/);
  assert.match(POWERSHELL_SCRIPT, /rootNotAfter/);
});

test('versioned CA metadata reuses the persistent root thumbprint and migrates legacy roots safely', () => {
  assert.equal(getPersistentRootThumbprint(' abcd1234 ', '2'), 'abcd1234');
  assert.equal(getPersistentRootThumbprint('abcd1234', '1'), '');
  assert.equal(getPersistentRootThumbprint('abcd1234', ''), '');
});

test('TLS material refreshes when the selected LAN address changes or a certificate nears expiry', () => {
  const now = Date.UTC(2026, 0, 1);
  const current = {
    addresses: ['127.0.0.1', '192.168.0.104'],
    rootNotAfter: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    leafNotAfter: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString()
  };
  assert.equal(isLocalTlsMaterialCurrent(current, '192.168.0.104', now), true);
  assert.equal(isLocalTlsMaterialCurrent(current, '192.168.0.105', now), false);
  assert.equal(isLocalTlsMaterialCurrent({ ...current, leafNotAfter: new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString() }, '192.168.0.104', now), false);
  assert.equal(isLocalTlsMaterialCurrent(current, '192.168.0.104', now + 400 * 24 * 60 * 60 * 1000), false);
});

test('LAN address selection prefers a private physical adapter over a virtual adapter', () => {
  const interfaces = {
    'vEthernet (Default Switch)': [
      { family: 'IPv4', address: '192.168.137.1', internal: false }
    ],
    WiFi: [
      { family: 'IPv4', address: '192.168.0.104', internal: false }
    ],
    'Loopback Pseudo-Interface': [
      { family: 'IPv4', address: '127.0.0.1', internal: true }
    ]
  };

  assert.equal(selectLanIPv4Address(interfaces), '192.168.0.104');
  assert.deepEqual(listLocalIPv4Addresses(interfaces, '192.168.0.104').slice(0, 2), [
    '127.0.0.1',
    '192.168.0.104'
  ]);
});

test('private IPv4 detection accepts RFC1918 ranges and rejects public or malformed values', () => {
  assert.equal(isPrivateIPv4Address('10.5.4.3'), true);
  assert.equal(isPrivateIPv4Address('172.31.4.3'), true);
  assert.equal(isPrivateIPv4Address('192.168.0.104'), true);
  assert.equal(isPrivateIPv4Address('172.32.4.3'), false);
  assert.equal(isPrivateIPv4Address('8.8.8.8'), false);
  assert.equal(isPrivateIPv4Address('not-an-ip'), false);
});

test('TLS certificate SAN list includes loopback and valid local IPv4 addresses only', () => {
  const addresses = listLocalIPv4Addresses({
    ethernet: [
      { family: 'IPv4', address: '192.168.1.20', internal: false },
      { family: 'IPv4', address: '127.0.0.1', internal: true },
      { family: 'IPv6', address: 'fe80::1234', internal: false },
      { family: 'IPv4', address: 'not-an-ip', internal: false }
    ]
  });
  assert.deepEqual(addresses, ['127.0.0.1', '192.168.1.20']);
});

test('TLS certificate SAN list has a bounded number of addresses', () => {
  const interfaces = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
    `adapter-${index}`,
    [{ family: 'IPv4', address: `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`, internal: false }]
  ]));
  assert.equal(listLocalIPv4Addresses(interfaces).length, 16);
});

test('TLS certificate SAN list always retains the selected LAN address', () => {
  const interfaces = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
    `adapter-${index}`,
    [{ family: 'IPv4', address: `10.0.${Math.floor(index / 254)}.${(index % 254) + 1}`, internal: false }]
  ]));
  const selectedAddress = '10.0.0.20';
  const addresses = listLocalIPv4Addresses(interfaces, selectedAddress);

  assert.equal(addresses.length, 16);
  assert.ok(addresses.includes(selectedAddress));
});
