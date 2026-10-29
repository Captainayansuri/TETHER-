const test = require('node:test');
const assert = require('node:assert/strict');
const { listLocalIPv4Addresses } = require('../local-tls');

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
