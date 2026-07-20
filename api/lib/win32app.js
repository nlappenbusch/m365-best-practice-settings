/**
 * Intune Win32-App-Upload (App-Deployment fuer Agents wie Bitdefender/N-sight).
 *
 * Microsofts eigener .intunewin-Container ist ein Zip-in-Zip aus reiner
 * Tooling-Konvention (IntuneWinAppUtil.exe) — Graph selbst bekommt nur (a) JSON-
 * Metadaten und (b) den bereits verschluesselten Content-Blob per direktem
 * Azure-Storage-Upload zu sehen. Wir bauen daher NICHT den aeusseren Container
 * nach, sondern nur das Verschluesselungsschema, das Graph tatsaechlich verlangt:
 * Installer -> ein-Datei-Zip (Store) -> AES-256-CBC verschluesseln -> HMAC-SHA256
 * ueber (IV || Ciphertext) -> SHA-256-Digest des Klartext-Zips. Ablauf danach
 * exakt nach Microsofts eigenem Content-Upload-Protokoll (siehe Kommentare).
 */
const crypto = require("crypto");
const { buildZip } = require("./zip");
const { graphReq } = require("./graph");

const CHUNK_SIZE = 6 * 1024 * 1024; // 6 MiB, wie Microsofts eigenes Upload-Tooling

/** Installer-Buffer fuer den Intune-Content-Upload vorbereiten. */
function encryptForIntune(installerBuffer, setupFileName) {
  const zipBuf = buildZip([{ name: setupFileName, data: installerBuffer }]);

  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(zipBuf), cipher.final()]);

  const macKey = crypto.randomBytes(32);
  const mac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();

  const fileDigest = crypto.createHash("sha256").update(zipBuf).digest();

  return {
    encryptedBuffer: Buffer.concat([mac, iv, ciphertext]),
    unencryptedContentSize: zipBuf.length,
    fileEncryptionInfo: {
      "@odata.type": "microsoft.graph.fileEncryptionInfo",
      encryptionKey: key.toString("base64"),
      initializationVector: iv.toString("base64"),
      mac: mac.toString("base64"),
      macKey: macKey.toString("base64"),
      profileIdentifier: "ProfileVersion1",
      fileDigest: fileDigest.toString("base64"),
      fileDigestAlgorithm: "SHA256"
    }
  };
}

/** Selbsttest: verschluesselt+entschluesselt einen Puffer und prueft Gleichheit. */
function selfTestEncryption() {
  const sample = crypto.randomBytes(1024 * 37 + 5); // krumme Groesse, testet Padding
  const { encryptedBuffer, fileEncryptionInfo } = encryptForIntune(sample, "test.bin");
  const mac = encryptedBuffer.subarray(0, 32);
  const iv = encryptedBuffer.subarray(32, 48);
  const ciphertext = encryptedBuffer.subarray(48);
  const macKey = Buffer.from(fileEncryptionInfo.macKey, "base64");
  const expectedMac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();
  if (!expectedMac.equals(mac)) throw new Error("Selftest: MAC stimmt nicht ueberein.");
  const key = Buffer.from(fileEncryptionInfo.encryptionKey, "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const zipBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const digest = crypto.createHash("sha256").update(zipBuf).digest();
  if (digest.toString("base64") !== fileEncryptionInfo.fileDigest) throw new Error("Selftest: FileDigest stimmt nicht ueberein.");
  if (!zipBuf.includes("test.bin")) throw new Error("Selftest: Setup-Dateiname nicht im Zip gefunden.");
  return true;
}

async function uploadToAzureBlob(azureStorageUri, buffer, onChunk) {
  const totalChunks = Math.max(1, Math.ceil(buffer.length / CHUNK_SIZE));
  const blockIds = [];
  const sep = azureStorageUri.includes("?") ? "&" : "?";
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const chunk = buffer.subarray(start, Math.min(start + CHUNK_SIZE, buffer.length));
    const blockId = Buffer.from(String(i).padStart(4, "0")).toString("base64");
    blockIds.push(blockId);
    const url = `${azureStorageUri}${sep}comp=block&blockid=${encodeURIComponent(blockId)}`;
    const r = await fetch(url, {
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain; charset=UTF-8" },
      body: chunk
    });
    if (!r.ok) throw new Error(`Azure-Blob-Upload fehlgeschlagen (Chunk ${i + 1}/${totalChunks}): HTTP ${r.status}`);
    if (onChunk) onChunk(i + 1, totalChunks);
  }
  const blockList = "<?xml version=\"1.0\" encoding=\"utf-8\"?><BlockList>" +
    blockIds.map(id => `<Latest>${id}</Latest>`).join("") + "</BlockList>";
  const r = await fetch(`${azureStorageUri}${sep}comp=blocklist`, {
    method: "PUT", headers: { "content-type": "text/plain; charset=UTF-8" }, body: blockList
  });
  if (!r.ok) throw new Error("Azure-Blob-Blockliste-Commit fehlgeschlagen: HTTP " + r.status);
}

async function pollFileStatus(tenant, certPemPath, appId, contentVersionId, fileId, wantStates, failStates, timeoutMsg) {
  let status;
  for (let tries = 0; tries < 90; tries++) {
    status = await graphReq(tenant, certPemPath, "GET",
      `/deviceAppManagement/mobileApps/${appId}/contentVersions/${contentVersionId}/files/${fileId}`);
    if (wantStates.includes(status.uploadState)) return status;
    if (failStates.includes(status.uploadState)) throw new Error("Upload-Status: " + status.uploadState);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(timeoutMsg);
}

/**
 * Kompletter Win32-App-Upload-Ablauf (Graph v1.0, kein Beta noetig):
 *   1. App-Objekt anlegen (win32LobApp-JSON, ohne Content-Felder)
 *   2. Content-Version anlegen
 *   3. Content-Datei-Platzhalter registrieren
 *   4. Auf Azure-Storage-SAS-URI warten
 *   5. Verschluesselten Blob chunked (6 MiB) nach Azure Blob Storage hochladen
 *   6. Commit mit fileEncryptionInfo
 *   7. Auf Commit-Bestaetigung warten
 *   8. App-Objekt mit committedContentVersion patchen (-> published)
 * opts: { appPayload, setupFileName, installerBuffer, onProgress(phaseLabel, extra) }
 */
async function createWin32AppWithContent(tenant, certPemPath, opts) {
  const onProgress = opts.onProgress || (() => {});

  onProgress("App-Objekt anlegen");
  const app = await graphReq(tenant, certPemPath, "POST", "/deviceAppManagement/mobileApps", opts.appPayload);
  const appId = app.id;
  // Frisch angelegtes App-Objekt kurz bestaetigen, bevor die verschachtelte
  // contentVersions-Ressource referenziert wird -- sonst gelegentlich
  // "Resource not found for the segment 'contentVersions'" durch
  // Verzeichnis-/Service-Replikationslag (gleiches Muster wie bei frisch
  // angelegten Gruppen, siehe appGroups.js::ensureAppGroup).
  await graphReq(tenant, certPemPath, "GET", `/deviceAppManagement/mobileApps/${appId}?$select=id`, null, { retryTransient: true });

  onProgress("Content-Version anlegen");
  const cv = await graphReq(tenant, certPemPath, "POST",
    `/deviceAppManagement/mobileApps/${appId}/contentVersions`,
    { "@odata.type": "#microsoft.graph.mobileAppContent" }, { retryTransient: true });
  const contentVersionId = cv.id;

  onProgress("Installer verschluesseln");
  const { encryptedBuffer, unencryptedContentSize, fileEncryptionInfo } = encryptForIntune(opts.installerBuffer, opts.setupFileName);

  onProgress("Content-Datei registrieren");
  const filePlaceholder = await graphReq(tenant, certPemPath, "POST",
    `/deviceAppManagement/mobileApps/${appId}/contentVersions/${contentVersionId}/files`,
    {
      "@odata.type": "#microsoft.graph.mobileAppContentFile",
      name: opts.setupFileName,
      size: unencryptedContentSize,
      sizeEncrypted: encryptedBuffer.length,
      isDependency: false
    });
  const fileId = filePlaceholder.id;

  onProgress("Auf Azure-Storage-URI warten");
  const ready = await pollFileStatus(tenant, certPemPath, appId, contentVersionId, fileId,
    ["azureStorageUriRequestSuccess"], ["azureStorageUriRequestFailed", "azureStorageUriRequestTimedOut"],
    "Azure-Storage-URI nicht erhalten (Timeout).");

  onProgress("Installer hochladen");
  await uploadToAzureBlob(ready.azureStorageUri, encryptedBuffer,
    (done, total) => onProgress("Installer hochladen", { done, total }));

  onProgress("Upload committen");
  await graphReq(tenant, certPemPath, "POST",
    `/deviceAppManagement/mobileApps/${appId}/contentVersions/${contentVersionId}/files/${fileId}/commit`,
    { fileEncryptionInfo });

  onProgress("Auf Commit-Bestaetigung warten");
  await pollFileStatus(tenant, certPemPath, appId, contentVersionId, fileId,
    ["commitFileSuccess"], ["commitFileFailed", "commitFileTimedOut"],
    "Commit-Bestaetigung nicht erhalten (Timeout).");

  onProgress("App veroeffentlichen");
  await graphReq(tenant, certPemPath, "PATCH", `/deviceAppManagement/mobileApps/${appId}`,
    { "@odata.type": "#microsoft.graph.win32LobApp", committedContentVersion: String(contentVersionId) });

  return { appId };
}

async function assignAppToGroup(tenant, certPemPath, appId, groupId) {
  // retryTransient: groupId kann eine in diesem selben Lauf frisch angelegte
  // Gruppe sein — Verzeichnis-Replikation kann noch nachhinken.
  await graphReq(tenant, certPemPath, "POST", `/deviceAppManagement/mobileApps/${appId}/assign`, {
    mobileAppAssignments: [
      {
        "@odata.type": "#microsoft.graph.mobileAppAssignment",
        intent: "required",
        target: { "@odata.type": "microsoft.graph.groupAssignmentTarget", groupId }
      }
    ]
  }, { retryTransient: true });
}

module.exports = { encryptForIntune, selfTestEncryption, createWin32AppWithContent, assignAppToGroup };
