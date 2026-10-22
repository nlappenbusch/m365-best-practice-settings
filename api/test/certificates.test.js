"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTenantCertificate } = require('../lib/certificates');
test('tenant certificate remains RSA 2048, matches private key and preserves 730-day validity', async () => {
  const pems = await createTenantCertificate('m365-test');
  const cert = new crypto.X509Certificate(pems.cert);
  const privateKey = crypto.createPrivateKey(pems.private);
  assert.equal(cert.publicKey.asymmetricKeyType,'rsa');
  assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength,2048);
  assert.equal(cert.checkPrivateKey(privateKey),true);
  assert.equal(cert.verify(cert.publicKey),true);
  assert.equal((Date.parse(cert.validTo)-Date.parse(cert.validFrom))/86400000,730);
});
