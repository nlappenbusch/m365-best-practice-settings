const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/managedService');

test('fleet counters distinguish missing sources from measured zero and preserve source timestamps', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-fleet-'));
  t.after(() => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('m365-fleet-'));
    fs.rmSync(resolved, { recursive:true, force:true });
  });
  const tenant = {id:'a',name:'Test'};
  const absent = S.fleetRow(dir,tenant);
  assert.equal(absent.licensedUsers,null);
  assert.equal(absent.totalUsers,null);
  assert.equal(absent.managedDevices,null);
  const at = '2026-10-22T10:00:00Z';
  S.writeJson(S.file(dir,'a','status.json'),{
    licenses:{ok:false,lastOkAt:at,metrics:[{label:'Lizenziert',value:0}]},
    devices:{ok:true,at,metrics:[{label:'Geräte',value:47}]}
  });
  fs.mkdirSync(path.join(dir,'managed','a','data'),{recursive:true});
  S.writeJson(S.file(dir,'a','data/licenses.json'),{totals:{users:18}});
  const measured = S.fleetRow(dir,tenant);
  assert.equal(measured.licensedUsers,0);
  assert.equal(measured.totalUsers,18);
  assert.equal(measured.managedDevices,47);
  assert.equal(measured.metricAt.licenses,at);
  assert.equal(measured.metricAt.devices,at);
  assert.equal(measured.metricAt.score,null);
  assert.deepEqual(measured.areasFailed,['Lizenzen & Drift']);
});
