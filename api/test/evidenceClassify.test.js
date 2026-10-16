"use strict";
// Klartext-Einordnung der Audit-Events — Muster aus dem PKRück-Tenant (16.10.2026).
const test = require("node:test");
const assert = require("node:assert");
const C = require("../lib/evidenceClassify");

const SELF = "cfe3f96e-4d85-4121-849e-d0b6d5015173";
const ev = (activity, actor, targets, at) => ({ eventId: "ev_" + Math.random().toString(16).slice(2), activity, actor, targets, occurredAt: at || "2026-10-15T09:55:00Z" });
const ch = (name, old, nw) => ({ name, old: old || "", new: nw || "" });
const v = e => C.view(e, { selfAppId: SELF });

test("Eigenes Werkzeug: Berechtigungen werden gebündelt, nicht kritisch", () => {
  const a = v(ev("Add app role assignment to service principal", "admin.lappenbusch@pkrueck.com", [
    { name: "Microsoft Graph", type: "ServicePrincipal", changes: [ch("AppRole.Value", "", '"RoleManagement.ReadWrite.Directory"'), ch("ServicePrincipal.AppId", "", `"${SELF}"`), ch("ServicePrincipal.DisplayName", "", '"M365-Security-Policy-Manager"')] }]));
  assert.equal(a.kind, "self");
  assert.equal(a.level, "medium");
  assert.match(a.title, /RoleManagement\.ReadWrite\.Directory/);
  const b = v(ev("Update service principal", "admin.lappenbusch@pkrueck.com", [{ name: "M365-Security-Policy-Manager", type: "ServicePrincipal", changes: [] }]));
  assert.equal(b.group, a.group);
});

test("Fremde App mit Schreibrecht ist kritisch, Leserecht hoch", () => {
  const w = v(ev("Add app role assignment to service principal", "x@kunde.ch", [{ name: "Microsoft Graph", changes: [ch("AppRole.Value", "", '"Mail.ReadWrite"'), ch("ServicePrincipal.DisplayName", "", '"Fremd-App"')] }]));
  assert.equal(w.level, "critical");
  assert.match(w.title, /Fremd-App.*Mail\.ReadWrite/);
  const r = v(ev("Add app role assignment to service principal", "x@kunde.ch", [{ name: "Microsoft Graph", changes: [ch("AppRole.Value", "", '"User.Read"'), ch("ServicePrincipal.DisplayName", "", '"Fremd-App"')] }]));
  assert.equal(r.level, "high");
});

test("Provisioning-Sync ist Routine — trotz IsSoftDeleted im Inhalt", () => {
  for (const act of ["Synchronization rule action", "Process escrow", "Import"]) {
    const x = v(ev(act, "Azure AD Cloud Sync", [{ name: "iGrafx P360", type: "ServicePrincipal", changes: [ch("IsSoftDeleted", "", '"False"'), ch("displayName", "", '"Prozessmanagement"')] }]));
    assert.equal(x.level, "info");
    assert.equal(x.routine, "Synchronisation");
    assert.equal(x.group, "sync:igrafx p360");
  }
});

test("Microsoft-Aufräumjob ist Routine", () => {
  const x = v(ev("Hard Delete device", "Microsoft Online Services Garbage Collector", [{ name: "MPKZH0275", type: "Device", changes: [] }]));
  assert.equal(x.routine, "Microsoft-Aufräumjob");
});

test("Authenticator: App-Update ist Routine, neues Gerät wird gemeldet", () => {
  const same = v(ev("Update user", "Azure MFA StrongAuthenticationService", [{ name: "jonas.hofer@pkrueck.com", changes: [ch("StrongAuthenticationPhoneAppDetail",
    '[{"DeviceName":"iPhone 13 mini","DeviceToken":"apns2-8508e9ecec0b5b2ac0afd1c64082a874e5f9","PhoneAppVersion":"6.8.55"', '[{"DeviceName":"iPhone 13 mini","DeviceToken":"apns2-8508e9ecec0b5b2ac0afd1c64082a874e5f9","PhoneAppVersion":"6.8.56"')] }]));
  assert.equal(same.routine, "Authenticator-App aktualisiert");
  const moved = v(ev("Update user", "Azure MFA StrongAuthenticationService", [{ name: "sonja.knutti@pkrueck.com", changes: [ch("StrongAuthenticationPhoneAppDetail",
    '[{"DeviceName":"iPhone","DeviceToken":"apns2-8169355a410ba088165c6328bcae40dd01","DeviceTag":"iOS"', '[{"DeviceName":"iPhone 11 Pro","DeviceToken":"apns2-11cb3314e4d2cf19d7d3f11e8fb3261205","DeviceTag":"SoftwareTokenActivated"')] }]));
  assert.equal(moved.level, "medium");
  assert.match(moved.title, /neuem Gerät \(iPhone → iPhone 11 Pro\)/);
  const admin = v(ev("Update user", "Azure MFA StrongAuthenticationService", [{ name: "admin.baer@pkrueck.com", changes: [ch("StrongAuthenticationPhoneAppDetail", '[{"DeviceName":"A","DeviceToken":"t1"', '[{"DeviceName":"B","DeviceToken":"t2"')] }]));
  assert.equal(admin.level, "high");
});

test("Anmeldemethode: Self-Service Routine, Admin-Konto gemeldet, Entfernen hoch", () => {
  assert.equal(v(ev("User registered security info", "Christian Cantieni", [{ name: "Christian Cantieni" }])).routine, "Anmeldemethode eingerichtet");
  assert.equal(v(ev("Get passkey creation options", "admin@pkrueck.com", [{ name: "PKRück Admin" }])).level, "medium");
  assert.equal(v(ev("User registered security info", "admin.jenny@pkrueck.com", [{ name: "Admin Jenny (GA)" }])).level, "medium");
  assert.equal(v(ev("User deleted security info", "Petra Meier", [{ name: "Petra Meier" }])).level, "high");
});

test("CSP-Partner und neuer Copilot-Agent werden sichtbar gemeldet", () => {
  const p = v(ev("Add delegated permission grant", "user_3f31b9fff88841a380092723648088d6@alsocspswitzerlandchf.onmicrosoft.com", [{ name: "Azure Resource Manager" }]));
  assert.equal(p.kind, "partner");
  assert.match(p.title, /alsocspswitzerlandchf/);
  const sp = v(ev("Add service principal", "PPMIProvisioningAppProd", [{ name: "Email Assist Agent (Microsoft Copilot Studio)", changes: [ch("AppPrincipalId", "[]", '["20472c03-756d-47a9-a2f7-c6ee98e3b684"]'), ch("DisplayName", "[]", '["Email Assist Agent (Microsoft Copilot Studio)"]')] }]));
  const owner = v(ev("Add owner to service principal", "PPMIProvisioningAppProd", [{ name: "PPMIProvisioningAppProd", changes: [ch("ServicePrincipal.AppId", "", '"20472c03-756d-47a9-a2f7-c6ee98e3b684"'), ch("ServicePrincipal.DisplayName", "", '"Email Assist Agent (Microsoft Copilot Studio)"')] }]));
  assert.equal(sp.level, "high");
  assert.match(sp.title, /Neuer KI-Agent/);
  assert.equal(sp.group, owner.group, "Anlegen + Besitzer = ein Bündel");
});

test("Auffangregel: Klartext, Admin-Rolle kritisch, Duplikate gebündelt", () => {
  assert.equal(v(ev("Add member to role", "x@kunde.ch", [{ name: "Max Muster" }])).level, "critical");
  const u = v(ev("Update user", "x@kunde.ch", [{ name: "Max Muster" }]));
  assert.equal(u.level, "info");
  assert.equal(u.title, "Benutzer geändert: Max Muster");
  const dupes = [1, 2, 3, 4, 5].map(() => { const e = ev("Hard Delete device", "Microsoft Online Services Garbage Collector", [{ name: "MPKZH0275" }]); e.view = v(e); return e; });
  assert.equal(C.groupEvents(dupes).length, 1);
});
