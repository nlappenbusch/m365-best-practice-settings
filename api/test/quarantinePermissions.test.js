const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildDeployBody, sanitizeConfig } = require('../lib/deploy');

const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const configSource = read('frontend/src/lib/config.js');
const config = vm.runInNewContext(configSource.slice(configSource.indexOf('export const defaultConfig'), configSource.indexOf('export const config')).replace('export const', 'const') + '\ndefaultConfig()');

function checkPolicyCommands(script) {
  for (const [name, expected] of [['SelfRelease', 55], ['RequestRelease', 26]]) {
    const commands = [...script.matchAll(new RegExp('(?:New|Set)-QuarantinePolicy[^\\n]*BP_Quarantine-' + name + 'Notification[\\s\\S]*?-EndUserQuarantinePermissionsValue (\\d+)', 'g'))];
    assert.equal(commands.length, 2, name + ': create and update');
    for (const command of commands) {
      const value = Number(command[1]);
      assert.equal(value, expected);
      assert.equal(Boolean(value & 4), name === 'SelfRelease', 'direct release');
      assert.equal(Boolean(value & 8), name === 'RequestRelease', 'request release');
    }
  }
}

test('live deploy and downloaded script grant direct release only to SelfRelease', async () => {
  checkPolicyCommands(buildDeployBody(sanitizeConfig(config)));
  const { makeExporters } = await import('../../frontend/src/lib/configExport.js');
  checkPolicyCommands(makeExporters(config).generateDeploymentScript());
});

test('audit rejects legacy request-only SelfRelease permissions and accepts direct release', () => {
  const source = read('frontend/src/tabs/Audit.svelte');
  const functions = source.slice(source.indexOf('  function ldDomainsEqual'), source.indexOf('  const iconFor'));
  const audit = vm.runInNewContext(functions + '\nbuildAuditGroups');
  const permissions = release => `PermissionToAllowSender: True, PermissionToBlockSender: True, PermissionToRequestRelease: ${release ? 'False' : 'True'}, PermissionToRelease: ${release ? 'True' : 'False'}, PermissionToPreview: True, PermissionToDelete: True`;
  for (const directRelease of [false, true]) {
    const result = audit({ quarantineSelf: { ESNEnabled: true, IncludeMessagesFromBlockedSenderAddress: true, Permissions: permissions(directRelease) } }, config, false, {});
    const check = result.groups[0].checks.find(c => c.label === 'SelfRelease: Berechtigungen (55)');
    assert.equal(check.state, directRelease ? 'ok' : 'bad');
    if (!directRelease) assert.match(check.detail, /Release fehlt/);
  }
});
