"use strict";
/**
 * Eigene Settings-Catalog-Policy (z.B. eine im Intune-Portal manuell erstellte
 * und per Graph wieder exportierte JSON) in einen Tenant importieren + einer
 * Gruppe zuweisen -- nutzt dieselbe bereits bewaehrte Transform-/Import-Logik
 * wie der OIB-Baseline-Import (oibImport.js), nur mit einer selbst
 * mitgebrachten JSON-Quelle statt dem GitHub-Baseline-Repo.
 *
 * Bewusst KEIN eigenstaendiges Bauen von Settings-Catalog-JSON aus einer
 * KI-Empfehlung heraus: die exakte settingDefinitionId/choiceSettingValue-
 * Struktur ist pro Einstellung und ADMX-Version sehr genau und laesst sich
 * nicht verlaesslich aus Dokumentation ableiten (selbst Microsofts eigene
 * Docs sind dazu unvollstaendig/widerspruechlich) -- der sichere, in der
 * Praxis uebliche Weg ist: Policy einmal manuell im Intune-Portal anlegen,
 * per Graph (GET .../configurationPolicies/{id}?$expand=settings) exportieren,
 * die JSON hier einspielen. Das ist derselbe Ansatz, den auch OIBDeployer/
 * OpenIntuneBaseline fuer ihre Baseline-Dateien verwenden.
 */
const { graphReq } = require("./graph");
const { transformForImport } = require("./oibImport");
const OIB = require("./oib");

function validatePolicyJson(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("Kein gueltiges JSON-Objekt."), { status: 400 });
  }
  const type = String(raw["@odata.type"] || "");
  if (type && !/deviceManagementConfigurationPolicy/i.test(type)) {
    throw Object.assign(new Error(`Erwartet eine Settings-Catalog-Policy (#microsoft.graph.deviceManagementConfigurationPolicy), bekommen: ${type || "(kein @odata.type)"}`), { status: 400 });
  }
  if (!Array.isArray(raw.settings) || !raw.settings.length) {
    throw Object.assign(new Error("JSON enthaelt kein (nicht-leeres) 'settings'-Array -- kein gueltiger Settings-Catalog-Export."), { status: 400 });
  }
}

/** rawJson: per Graph exportierte deviceManagementConfigurationPolicy. */
async function importCustomPolicy(tenant, cert, rawJson, groupId) {
  validatePolicyJson(rawJson);
  if (!groupId) throw Object.assign(new Error("Keine Ziel-Gruppe angegeben."), { status: 400 });

  const payload = transformForImport(rawJson, tenant.tenantId);
  const beta = { beta: true, retryTransient: true };
  const created = await graphReq(tenant, cert, "POST", "/deviceManagement/configurationPolicies", payload, beta);
  const assignStatus = await OIB.assignPolicyToGroup(tenant, cert, { id: created.id, apiType: "configurationPolicies" }, groupId);
  return { policyId: created.id, policyName: created.name, assignStatus };
}

module.exports = { importCustomPolicy, validatePolicyJson };
