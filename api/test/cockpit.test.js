"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/cockpit');
const xml = (rows = '') => `<feedback><report_metadata><org_name>Reporter</org_name><report_id>r1</report_id><date_range><begin>1700000000</begin><end>1700086400</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>reject</p></policy_published>${rows}</feedback>`;
const row = (count,dkim,spf) => `<record><row><source_ip>192.0.2.1</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>${dkim}</dkim><spf>${spf}</spf></policy_evaluated></row></record>`;

test('DMARC uses aligned policy results and message counts, supports single/multiple records', () => {
  const r = C.parseDmarc(xml(row(10,'fail','pass') + row(3,'fail','fail')));
  assert.equal(r.total,13); assert.equal(r.failed,3);
  assert.equal(C.parseDmarc(xml(row(2,'pass','fail'))).failed,0);
  assert.equal(C.parseDmarc(xml()).total,0);
});
test('DMARC rejects entities, malformed XML, invalid dates, negative counts and oversized input', () => {
  for (const value of ['<!DOCTYPE feedback><feedback/>','<!ENTITY a SYSTEM "file:///etc/passwd">','<feedback>',xml(row(-1,'fail','fail')),xml().replace('1700086400','0'),'x'.repeat(450001)]) assert.throws(() => C.parseDmarc(value));
});
test('DMARC deduplication key includes reporter as well as domain/report ID', () => {
  const a = C.parseDmarc(xml()), b = C.parseDmarc(xml().replace('Reporter','Different'));
  assert.equal(a.key,C.parseDmarc(xml()).key); assert.notEqual(a.key,b.key);
});
test('app risk distinguishes tenant-wide write, critical privilege and benign default access', () => {
  assert.equal(C.appRisk(['Mail.ReadWrite.All']).level,'critical');
  assert.equal(C.appRisk(['User.ReadWrite.All']).level,'high');
  assert.equal(C.appRisk(['User.Read.All']).level,'medium');
  assert.equal(C.appRisk([]).level,'low');
  assert.equal(C.appRisk(['Directory.ReadWrite.All','Directory.ReadWrite.All']).score,100);
});
test('rule validation rejects malformed names, severities and thresholds', () => {
  const good = { name:'Test',severity:'high',threshold:1 };
  assert.ok(C.validateRule(good).id);
  for (const b of [{...good,name:''},{...good,severity:'anything'},{...good,threshold:0},{...good,threshold:1.5},{...good,threshold:10001}]) assert.throws(() => C.validateRule(b));
});
