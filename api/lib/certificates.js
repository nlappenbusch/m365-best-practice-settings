"use strict";
const selfsigned = require('selfsigned');
async function createTenantCertificate(commonName) {
  const now = new Date();
  return selfsigned.generate([{ name:'commonName',value:commonName }], {
    keyType:'rsa',keySize:2048,algorithm:'sha256',notBeforeDate:now,
    notAfterDate:new Date(now.getTime() + 730 * 86400000)
  });
}
module.exports = { createTenantCertificate };
