/**
 * Conditional-Access-Policy-Vorlagen, verbatim uebernommen (mechanisch abgerufen,
 * nicht manuell abgetippt - Sicherheitsrelevanz macht Transkriptionsfehler
 * inakzeptabel) aus dem MIT-lizenzierten Repo AlexFilipin/ConditionalAccess
 * (https://github.com/AlexFilipin/ConditionalAccess), Stand: 20260720-Abruf.
 *
 * EINZIGE bewusste Abweichung vom Upstream (01.09.2026): Policy 200 heisst dort
 * "All apps: Require Strong Auth or trusted device or trusted location", hat aber
 * builtInControls=[] - eine Geraete-Alternative existiert nicht. Der Name ist im
 * Upstream schlicht falsch; die Policy selbst ist korrekt und strenger als ihr
 * Name behauptet. Hier auf "Require Strong Auth or trusted location" korrigiert,
 * analog zu Policy 211, die bei identischer Konstruktion (builtInControls=[] +
 * authenticationStrength) genau so heisst.
 *   NICHT "reparieren", indem man ["compliantDevice","domainJoinedDevice"] setzt:
 *   der Operator ist OR, jedes zusaetzliche Control ist ein zusaetzlicher Weg
 *   hinein. Das wuerde die Policy schwaechen (Geraet statt MFA genuegt) und im
 *   bareMinimum-Tier die unten zugesicherte Intune-Freiheit brechen.
 *   Upstream-Meldung: siehe docs/upstream-issue-ca200.md
 *
 * Drei Tiers:
 *  - bareMinimum: nur Authentication-Strength/MFA-Grant-Controls - KEINE
 *    Geraete-Compliance-Anforderung irgendeiner Art (verifiziert: keine Policy
 *    verlangt compliantDevice/domainJoinedDevice als einzige Bedingung).
 *    Funktioniert also auch fuer Tenants ohne Intune-verwaltete Geraete.
 *  - aadp1: erweitert um Geraete-Compliance als zusaetzliche/alternative Optionen
 *    (Entra ID P1 vorausgesetzt).
 *  - aadp1p2: zusaetzlich Sign-in-/User-Risk-basierte Policies (Entra ID P2 /
 *    Identity Protection vorausgesetzt).
 *
 * Platzhalter in den Policies (werden beim Deploy ersetzt, siehe conditionalAccess.js):
 *   <RING>                              -> "BP" (Best-Practice-Praefix, wie ueberall im Tool)
 *   <AdministratorGroup>                -> entfernt (die Rollen-IDs im selben Feld decken Admins bereits ab)
 *   <ExclusionTempGroup>                -> AAD-CA-ExclusionTemp (temporaere Ausnahmen, z.B. Troubleshooting)
 *   <ExclusionPermGroup>                -> AAD-CA-ExclusionPermanent (dauerhafte Ausnahmen, z.B. Legacy-Systemkonten)
 *   <EmergencyAccessAccountsGroup>       -> AAD-CA-BreakGlass (Notfallzugriffskonten - WICHTIG: manuell befuellen!)
 *   <SynchronizationServiceAccountsGroup> -> AAD-CA-SyncAccounts (Entra-Connect-/Sync-Dienstkonten)
 *
 * WICHTIG: Jede Policy wird beim Deploy IMMER mit state="enabledForReportingButNotEnforced"
 * angelegt, unabhaengig vom state-Feld in diesen Vorlagen - siehe deployTier() in
 * conditionalAccess.js. Eine Policy wird niemals automatisch scharf geschaltet.
 */
const CA_POLICY_TEMPLATES = {
  "bareMinimum": [
    {
      "displayName": "100 - <RING> - Admin protection - All apps: Require Strong Auth For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "104 - <RING> - Admin protection - Privileged systems: Require Strong Auth",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "110 - <RING> - Admin protection - All apps: Require MFA For BreakGlassAccount",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<EmergencyAccessAccountsGroup>"
          ],
          "excludeGroups": [],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "200 - <RING> - Base protection - All apps: Require Strong Auth or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "201 - <RING> - Base protection - Register security information: Require MFA or trusted device or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registersecurityinfo"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa",
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "211 - <RING> - Base protection - Register or Join Entra ID Device: Require Strong Auth or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "all"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registerdevice"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "300 - <RING> - Attack surface reduction - All apps: Block access When using other clients",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "other"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "301 - <RING> - Attack surface reduction - All apps: Block access When using active sync",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "exchangeActiveSync"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "306 - <RING> - Attack surface reduction - All apps: Block Authentication Transfer",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "authenticationTransfer"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "307 - <RING> - Attack surface reduction - All apps: Block Device Code Flow",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "deviceCodeFlow"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    }
  ],
  "aadp1": [
    {
      "displayName": "100 - <RING> - Admin protection - All apps: Require Strong Auth For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "101 - <RING> - Admin protection - All apps: Require trusted device For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "102 - <RING> - Admin protection - All apps: Block access For admins When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "104 - <RING> - Admin protection - Privileged systems: Require Strong Auth",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "105 - <RING> - Admin protection - Privileged systems: Require trusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "106 - <RING> - Admin protection - Privileged systems: Block access When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "110 - <RING> - Admin protection - All apps: Require MFA For BreakGlassAccount",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<EmergencyAccessAccountsGroup>"
          ],
          "excludeGroups": [],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "200 - <RING> - Base protection - All apps: Require Strong Auth or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "201 - <RING> - Base protection - Register security information: Require MFA or trusted device or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registersecurityinfo"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa",
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "210 - <RING> - Base protection - All apps: Require ToU for external Users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "locations": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": [],
          "includeGuestsOrExternalUsers": {
            "guestOrExternalUserTypes": "internalGuest,b2bCollaborationGuest,b2bCollaborationMember,b2bDirectConnectUser,otherExternalUser,serviceProvider",
            "externalTenants": {
              "@odata.type": "#microsoft.graph.conditionalAccessAllExternalTenants",
              "membershipKind": "all"
            }
          }
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [
          "ToU"
        ]
      }
    },
    {
      "displayName": "211 - <RING> - Base protection - Register or Join Entra ID Device: Require Strong Auth or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "all"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registerdevice"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "300 - <RING> - Attack surface reduction - All apps: Block access When using other clients",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "other"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "301 - <RING> - Attack surface reduction - All apps: Block access When using active sync",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "exchangeActiveSync"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "302 - <RING> - Attack surface reduction - All apps: Block access When using unknown device platforms",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "all"
          ],
          "excludePlatforms": [
            "android",
            "iOS",
            "windows",
            "macOS"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "304 - <RING> - Attack surface reduction - All apps: Block access When using other clients on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "other"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "305 - <RING> - Attack surface reduction - All apps: Block access When using active sync on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "exchangeActiveSync"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "306 - <RING> - Attack surface reduction - All apps: Block Authentication Transfer",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "authenticationTransfer"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "307 - <RING> - Attack surface reduction - All apps: Block Device Code Flow",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "deviceCodeFlow"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "400 - <RING> - Application protection - Specific apps: Require MFA",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "401 - <RING> - Application protection - Specific apps: Require trusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "402 - <RING> - Application protection - Specific apps: Block access When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "408 - <RING> - Application protection - Specific apps: Require trusted device or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "409 - <RING> - Application protection - Specific apps: Require Strong Auth",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "500 - <RING> - Data protection - All apps: No persistent browser session When on untrusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "signInFrequency": null,
        "persistentBrowser": {
          "mode": "never",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "501 - <RING> - Data protection - All apps: Short Sign-in frequency When on untrusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "persistentBrowser": null,
        "signInFrequency": {
          "value": 12,
          "type": "hours",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "502 - <RING> - Data protection - O365: Require app protection policy or approved client app For internal users When using mobile apps on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantApplication",
          "approvedApplication"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "503 - <RING> - Data protection - O365: Require approved client app When using modern authentication clients on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "approvedApplication"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "504 - <RING> - Data protection - O365: Require trusted device When using desktop clients on Windows and macOS",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "windows",
            "macOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "505 - <RING> - Data protection - O365: Use app enforced restrictions When using a browser on untrusted devices",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "cloudAppSecurity": null,
        "signInFrequency": null,
        "persistentBrowser": null,
        "applicationEnforcedRestrictions": {
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "506 - <RING> - Data protection - O365: Block access When using mobile apps and desktop clients on unknown device platforms",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "all"
          ],
          "excludePlatforms": [
            "android",
            "iOS",
            "windows",
            "macOS"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "507 - <RING> - Data protection - O365: Block access For external users When using mobile apps on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "GuestsOrExternalUsers"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "508 - <RING> - Data protection - All Apps: Block Downloads When using a browser for external Users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "GuestsOrExternalUsers"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": null
      },
      "grantControls": null,
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": {
          "cloudAppSecurityType": "blockDownloads",
          "isEnabled": true
        },
        "persistentBrowser": null,
        "signInFrequency": null
      }
    },
    {
      "displayName": "509 - <RING> - Data protection - All apps: Short Sign-in frequency When M365 Admin",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "GrantControls": {},
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "persistentBrowser": null,
        "signInFrequency": {
          "value": 1,
          "type": "hours",
          "isEnabled": true
        }
      }
    }
  ],
  "aadp1p2": [
    {
      "displayName": "100 - <RING> - Admin protection - All apps: Require Strong Auth For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "101 - <RING> - Admin protection - All apps: Require trusted device For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "102 - <RING> - Admin protection - All apps: Block access For admins When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "103 - <RING> - Admin protection - All apps: Block access For internal admins When any sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "high",
          "medium",
          "low"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "104 - <RING> - Admin protection - Privileged systems: Require Strong Auth",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "105 - <RING> - Admin protection - Privileged systems: Require trusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "106 - <RING> - Admin protection - Privileged systems: Block access When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "107 - <RING> - Admin protection - Privileged systems: Block access For internal users When any sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "high",
          "medium",
          "low"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "108 - <RING> - Admin protection - Privileged systems: Require trusted device or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "797f4846-ba00-4fd7-ba43-dac1f8f63013",
            "MicrosoftAdminPortals"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "109 - <RING> - Admin protection - All apps: Require trusted device or trusted location For admins",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "110 - <RING> - Admin protection - All apps: Require MFA For BreakGlassAccount",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<EmergencyAccessAccountsGroup>"
          ],
          "excludeGroups": [],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "200 - <RING> - Base protection - All apps: Require Strong Auth or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "201 - <RING> - Base protection - Register security information: Require MFA or trusted device or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registersecurityinfo"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa",
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "202 - <RING> - Base protection - All apps: Require Strong Auth When medium or above sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "medium",
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "203 - <RING> - Base protection - All apps: Block access When high sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "204 - <RING> - Base protection - All apps: Require Strong Auth For licensed users When medium or above sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "medium",
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AADP2Group>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "205 - <RING> - Base protection - All apps: Block access For licensed users When high sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AADP2Group>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "206 - <RING> - Base protection - All apps: Require password change When high user risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "userRiskLevels": [
          "high"
        ],
        "signInRiskLevels": [],
        "clientAppTypes": [
          "All"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "AND",
        "builtInControls": [
          "mfa",
          "passwordChange"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "207 - <RING> - Base protection - All apps: Require password change For licensed users When high user risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "userRiskLevels": [
          "high"
        ],
        "signInRiskLevels": [],
        "clientAppTypes": [
          "All"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AADP2Group>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "AND",
        "builtInControls": [
          "mfa",
          "passwordChange"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "208 - <RING> - Base protection - All apps: Require Strong Auth or trusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "locations": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>",
            "<SynchronizationServiceAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "209 - <RING> - Base protection - All apps: Require Token Protection for EXO and SPO Desktop Apps (preview)",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": {
        "secureSignInSession": {
          "isEnabled": true
        }
      },
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "platforms": {
          "includePlatforms": [
            "windows"
          ],
          "excludePlatforms": []
        },
        "deviceStates": null,
        "locations": null,
        "applications": {
          "includeApplications": [
            "00000002-0000-0ff1-ce00-000000000000",
            "00000003-0000-0ff1-ce00-000000000000"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      }
    },
    {
      "displayName": "210 - <RING> - Base protection - All apps: Require ToU for external Users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "locations": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": [],
          "includeGuestsOrExternalUsers": {
            "guestOrExternalUserTypes": "internalGuest,b2bCollaborationGuest,b2bCollaborationMember,b2bDirectConnectUser,otherExternalUser,serviceProvider",
            "externalTenants": {
              "@odata.type": "#microsoft.graph.conditionalAccessAllExternalTenants",
              "membershipKind": "all"
            }
          }
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [
          "ToU"
        ]
      }
    },
    {
      "displayName": "211 - <RING> - Base protection - Register or Join Entra ID Device: Require Strong Auth or trusted location For internal users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "all"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [],
          "excludeApplications": [],
          "includeUserActions": [
            "urn:user:registerdevice"
          ]
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "300 - <RING> - Attack surface reduction - All apps: Block access When using other clients",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "other"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "301 - <RING> - Attack surface reduction - All apps: Block access When using active sync",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "exchangeActiveSync"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "302 - <RING> - Attack surface reduction - All apps: Block access When using unknown device platforms",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "all"
          ],
          "excludePlatforms": [
            "android",
            "iOS",
            "windows",
            "macOS"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "304 - <RING> - Attack surface reduction - All apps: Block access When using other clients on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "other"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "305 - <RING> - Attack surface reduction - All apps: Block access When using active sync on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "exchangeActiveSync"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "306 - <RING> - Attack surface reduction - All apps: Block Authentication Transfer",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "authenticationTransfer"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "307 - <RING> - Attack surface reduction - All apps: Block Device Code Flow",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": [],
        "authenticationFlows": {
          "transferMethods": "deviceCodeFlow"
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "400 - <RING> - Application protection - Specific apps: Require MFA",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "401 - <RING> - Application protection - Specific apps: Require trusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "402 - <RING> - Application protection - Specific apps: Block access When on untrusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "403 - <RING> - Application protection - Specific apps: MCAS monitoring",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "signInFrequency": null,
        "persistentBrowser": null,
        "cloudAppSecurity": {
          "cloudAppSecurityType": "monitorOnly",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "404 - <RING> - Application protection - Specific apps: MCAS block downloads",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "signInFrequency": null,
        "persistentBrowser": null,
        "cloudAppSecurity": {
          "cloudAppSecurityType": "blockDownloads",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "405 - <RING> - Application protection - Specific apps: MCAS custom policy",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "signInFrequency": null,
        "persistentBrowser": null,
        "cloudAppSecurity": {
          "cloudAppSecurityType": "mcasConfigured",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "406 - <RING> - Application protection - Specific apps: Require MFA When low or above sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "low",
          "medium",
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "407 - <RING> - Application protection - Specific apps: Require MFA For licensed users When low or above sign-in risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [
          "low",
          "medium",
          "high"
        ],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AADP2Group>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "mfa"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "408 - <RING> - Application protection - Specific apps: Require trusted device or trusted location",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "locations": {
          "includeLocations": [
            "All"
          ],
          "excludeLocations": [
            "AllTrusted"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "409 - <RING> - Application protection - Specific apps: Require Strong Auth",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    },
    {
      "displayName": "500 - <RING> - Data protection - All apps: No persistent browser session When on untrusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "signInFrequency": null,
        "persistentBrowser": {
          "mode": "never",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "501 - <RING> - Data protection - All apps: Short Sign-in frequency When on untrusted device",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "persistentBrowser": null,
        "signInFrequency": {
          "value": 12,
          "type": "hours",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "502 - <RING> - Data protection - O365: Require app protection policy or approved client app For internal users When using mobile apps on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [
            "GuestsOrExternalUsers"
          ],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantApplication",
          "approvedApplication"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "503 - <RING> - Data protection - O365: Require approved client app When using modern authentication clients on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "approvedApplication"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "504 - <RING> - Data protection - O365: Require trusted device When using desktop clients on Windows and macOS",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "windows",
            "macOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "compliantDevice",
          "domainJoinedDevice"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "505 - <RING> - Data protection - O365: Use app enforced restrictions When using a browser on untrusted devices",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "grantControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "devices": {
          "deviceFilter": {
            "mode": "exclude",
            "rule": "device.isCompliant -eq True -or device.trustType -eq \"ServerAD\""
          }
        }
      },
      "sessionControls": {
        "cloudAppSecurity": null,
        "signInFrequency": null,
        "persistentBrowser": null,
        "applicationEnforcedRestrictions": {
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "506 - <RING> - Data protection - O365: Block access When using mobile apps and desktop clients on unknown device platforms",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "all"
          ],
          "excludePlatforms": [
            "android",
            "iOS",
            "windows",
            "macOS"
          ]
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "507 - <RING> - Data protection - O365: Block access For external users When using mobile apps on iOS or Android",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "mobileAppsAndDesktopClients"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "Office365"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "GuestsOrExternalUsers"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": {
          "includePlatforms": [
            "android",
            "iOS"
          ],
          "excludePlatforms": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "508 - <RING> - Data protection - All Apps: Block Downloads When using a browser for external Users",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser"
        ],
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "GuestsOrExternalUsers"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "platforms": null
      },
      "grantControls": null,
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": {
          "cloudAppSecurityType": "blockDownloads",
          "isEnabled": true
        },
        "persistentBrowser": null,
        "signInFrequency": null
      }
    },
    {
      "displayName": "509 - <RING> - Data protection - All apps: Short Sign-in frequency When M365 Admin",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [],
          "excludeUsers": [],
          "includeGroups": [
            "<AdministratorGroup>"
          ],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>",
            "<EmergencyAccessAccountsGroup>"
          ],
          "includeRoles": [
            "62e90394-69f5-4237-9190-012177145e10",
            "10dae51f-b6af-4016-8d66-8c2a99b929b3",
            "2af84b1e-32c8-42b7-82bc-daa82404023b",
            "95e79109-95c0-4d8e-aee3-d01accf2d47b",
            "fe930be7-5e62-47db-91af-98c3a49a38b1",
            "729827e3-9c14-49f7-bb1b-9608f156bbb8",
            "f023fd81-a637-4b56-95fd-791ac0226033",
            "b0f54661-2d74-4c50-afa3-1ec803f12efe",
            "4ba39ca4-527c-499a-b93d-d9b492c50246",
            "e00e864a-17c5-4a4b-9c06-f5b95a8d5bd8",
            "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
            "9360feb5-f418-4baa-8175-e2a00bac4301",
            "29232cdf-9323-42fd-ade2-1d097af3e4de",
            "f28a1f50-f6e7-4571-818b-6a12f2af6b6c",
            "75941009-915a-4869-abe7-691bff18279e",
            "d405c6df-0af8-4e3b-95e4-4d06e542189e",
            "9f06204d-73c1-4d4c-880a-6edb90606fd8",
            "9c094953-4995-41c8-84c8-3ebb9b32c93f",
            "c34f683f-4d5a-4403-affd-6615e00e3a7f",
            "17315797-102d-40b4-93e0-432062caca18",
            "d29b2b05-8046-44ba-8758-1e26182fcf32",
            "2b499bcd-da44-4968-8aec-78e1674fa64d",
            "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
            "cf1c38e5-3621-4004-a7cb-879624dced7c",
            "5d6b6bb7-de71-4623-b4af-96380a352509",
            "194ae4cb-b126-40b2-bd5b-6091b380977d",
            "e8611ab8-c189-46e8-94e1-60213ab1f814",
            "3a2c62db-5318-420d-8d74-23affee5d9d5",
            "158c047a-c907-4556-b7ef-446551a6b5f7",
            "5c4f9dcd-47dc-4cf7-8c9a-9e4207cbfc91",
            "44367163-eba1-44c3-98af-f5787879f96a",
            "a9ea8996-122f-4c74-9520-8edcd192826c",
            "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9",
            "4a5d8f65-41da-4de4-8968-e035b65339cf",
            "790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b",
            "7495fdc4-34c4-4d15-a289-98788ce399fd",
            "38a96431-2bdf-4b4c-8b6e-5d3d8abac1a4",
            "4d6ac14f-3453-41d0-bef9-a3e0c569773a",
            "7698a772-787b-4ac8-901f-60d6b08affd2",
            "c4e39bd9-1100-46d3-8c65-fb160da0071f",
            "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
            "baf37b3a-610e-45da-9e62-d9d1e5e8914b",
            "f70938a0-fc10-4177-9e90-2178f8765737",
            "fcf91098-03e3-41a9-b5ba-6f0ec8188a12",
            "69091246-20e8-4a56-aa4d-066075b2a7a8",
            "eb1f4a8d-243a-41f0-9fbd-c7cdf6c5ef7c",
            "ac16e43d-7b2d-40e0-ac05-243ff356ab5b",
            "6e591065-9bad-43ed-90f3-e9424366d2f0",
            "0f971eea-41eb-4569-a71e-57bb8a3eff1e",
            "aaf43236-0c0d-4d5f-883a-6955382ac081",
            "3edaf663-341e-4475-9f94-5c398ef6c070",
            "be2f45a1-457d-42af-a067-6ec1fa63bc45",
            "e6d1a23a-da11-4be4-9570-befc86d067a7",
            "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
            "74ef975b-6605-40af-a5d2-b9539d836353",
            "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
            "0964bb5e-9bdb-4d7b-ac29-58e794862a40",
            "8835291a-918c-4fd7-a9ce-faa49f0cf7d9",
            "966707d0-3269-4727-9be2-8c3a10f19b9d",
            "644ef478-e28f-4e28-b9dc-3fdde9aa0b1f",
            "e8cef6f1-e4bd-4ea8-bc07-4b8d950f4477",
            "0526716b-113d-4c15-b2c8-68e3c22b9f80",
            "fdd7a751-b60b-444a-984c-02652fe8fa1c",
            "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
            "e3973bdf-4987-49ae-837a-ba8e231c7286",
            "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2",
            "2b745bdf-0803-4d80-aa65-822c4493daac",
            "d37c8bed-0711-4417-ba38-b4abe66ce4c2",
            "31e939ad-9672-4796-9c2e-873181342d2d",
            "3d762c5a-1b6c-493f-843e-55a3b42923d4",
            "c430b396-e693-46cc-96f3-db01bf8bb62a",
            "9c6df0f2-1e7c-4dc3-b195-66dfbd24aa8f",
            "75934031-6c7e-415a-99d7-48dbd49e875e",
            "b5a8dcf3-09d5-43a9-a639-8e29ef291470",
            "744ec460-397e-42ad-a462-8b3f9747a02c",
            "8329153b-31d0-4727-b945-745eb3bc5f31",
            "8424c6f0-a189-499e-bbd0-26c1753c96d4",
            "58a13ea3-c632-46ae-9ee0-9c0d43cd7f3d",
            "1d336d2c-4ae8-42ef-9711-b3604ce3fc2c",
            "ffd52fa5-98dc-465c-991d-fc073eb59f8f",
            "31392ffb-586c-42d1-9346-e59415a2cc4e",
            "45d8d3c5-c802-45c6-b32a-1d70b5e1e86e",
            "892c5842-a9a6-463a-8041-72aa08ca3cf6",
            "32696413-001a-46ae-978c-ce0f6b3620d2",
            "11451d60-acb2-45eb-a7d6-43d0f0125c13",
            "3f1acade-1e04-4fbc-9b69-f0302cd84aef",
            "810a2642-a034-447f-a5e8-41beaa378541",
            "25a516ed-2fa0-40ea-a2d0-12923a21473a",
            "e300d9e7-4a2b-4295-9eff-f1c78b36cc98",
            "25df335f-86eb-4119-b717-0ff02de207e9",
            "1501b917-7653-4ff9-a4b5-203eaf33784f",
            "281fe777-fb20-4fbb-b7a3-ccebce5b0d96",
            "112ca1a2-15ad-4102-995e-45b0bc479a6a",
            "59d46f88-662b-457b-bceb-5c3809e5908f",
            "92b086b3-e367-4ef2-b869-1de128fb986e",
            "27460883-1df1-4691-b032-3b79643e5e63",
            "af78dc32-cf4d-46f9-ba4e-4428526346b5",
            "507f53e4-4e52-4077-abd3-d2e1558b6ea2",
            "ac434307-12b9-4fa1-a708-88bf58caabc1",
            "87761b17-1ed2-4af3-9acd-92a150038160",
            "dd13091a-6207-4fc0-82ba-3641e056ab95",
            "5b784334-f94b-471a-a387-e7219fc49ca2",
            "9c99539d-8186-4804-835f-fd51ef9e2dcd",
            "aa38014f-0993-46e9-9b45-30501a20909d",
            "963797fb-eb3b-4cde-8ce3-5878b3f32a3f",
            "8c8b803f-96e1-4129-9349-20738d9f9652",
            "1a7d78b6-429f-476b-b8eb-35fb715fffd4",
            "92ed04bf-c94a-4b82-9729-b799a7a4c178"
          ],
          "excludeRoles": []
        }
      },
      "GrantControls": {},
      "sessionControls": {
        "applicationEnforcedRestrictions": null,
        "cloudAppSecurity": null,
        "persistentBrowser": null,
        "signInFrequency": {
          "value": 1,
          "type": "hours",
          "isEnabled": true
        }
      }
    },
    {
      "displayName": "600 - <RING> - Compliance - Specific apps: Block access",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "None"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [],
          "includeRoles": [],
          "excludeRoles": []
        }
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "601 - <RING> - Compliance - All Apps: Block Access when Elevated Insider Risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "insiderRiskLevels": "elevated"
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [
          "block"
        ],
        "customAuthenticationFactors": [],
        "termsOfUse": []
      }
    },
    {
      "displayName": "602 - <RING> - Compliance - All Apps: Require Strong Auth When Moderate Insider Risk is detected",
      "createdDateTime": null,
      "modifiedDateTime": null,
      "state": "enabledForReportingButNotEnforced",
      "sessionControls": null,
      "conditions": {
        "signInRiskLevels": [],
        "clientAppTypes": [
          "browser",
          "mobileAppsAndDesktopClients"
        ],
        "platforms": null,
        "locations": null,
        "deviceStates": null,
        "devices": null,
        "applications": {
          "includeApplications": [
            "All"
          ],
          "excludeApplications": [],
          "includeUserActions": []
        },
        "users": {
          "includeUsers": [
            "All"
          ],
          "excludeUsers": [],
          "includeGroups": [],
          "excludeGroups": [
            "<ExclusionTempGroup>",
            "<ExclusionPermGroup>"
          ],
          "includeRoles": [],
          "excludeRoles": []
        },
        "insiderRiskLevels": "moderate"
      },
      "grantControls": {
        "operator": "OR",
        "builtInControls": [],
        "customAuthenticationFactors": [],
        "termsOfUse": [],
        "authenticationStrength": {
          "id": "00000000-0000-0000-0000-000000000004"
        }
      }
    }
  ]
};

/* ---------------------------------------------------------------------------
 *  Zusammenstellung: "Geraet statt Standort"
 * ---------------------------------------------------------------------------
 * Kein Kundensonderfall, sondern eine allgemeine Grundlinie: Der Zugriff haengt
 * am Geraetezustand, nicht am Aufenthaltsort. Wo eine Laendersperre existiert,
 * wird sie dadurch abgeloest statt ergaenzt.
 *
 * VORAUSSETZUNG: Die Geraete muessen in Intune verwaltet sein. Ohne das ist 401
 * keine Grundlinie, sondern eine Aussperrung - dann gehoert bareMinimum genommen.
 *
 * Zwei Varianten, die sich nur in der MFA-Haelfte unterscheiden:
 *   deviceFirst        -> 400, verlangt "mfa" (Authenticator genuegt)
 *   deviceFirstStrong  -> 409, verlangt phishing-resistente Authentication
 *                         Strength. Nur sinnvoll, wo FIDO2/Windows Hello
 *                         tatsaechlich ausgerollt ist - sonst sperrt es beim
 *                         Scharfschalten alle aus.
 *
 * Warum ZWEI Policies (400 und 401) und nicht eine kombinierte:
 *   Innerhalb einer Policy sind die Gewaehrungen mit OR verknuepft - jedes
 *   zusaetzliche Control ist ein weiterer WEG HINEIN, keine zusaetzliche Huerde.
 *   Eine Vorlage wie 208 ("Strong Auth or trusted device") bedeutet deshalb:
 *   wer ein verwaltetes Geraet hat, braucht gar keine MFA mehr - schwaecher als
 *   ein Tenant, der heute schon MFA erzwingt.
 *   ZWISCHEN Policies gilt das Gegenteil: alle zutreffenden muessen erfuellt
 *   sein. 400 (MFA) + 401 (verwaltetes Geraet) ergibt also das UND, das eine
 *   einzelne Policy nicht liefern kann - und jede behaelt ihre eigenen
 *   Ausnahmen und ihren eigenen Zeitpunkt zum Scharfschalten.
 *
 * Bewusst NICHT enthalten: alles, was eine phishing-resistente Authentication
 * Strength verlangt (100, 104, 200, 211). Nicht weil es falsch waere, sondern
 * weil starke Auth hier nicht als Anforderung gesetzt werden soll - ohne
 * ausgerollte FIDO2-/Windows-Hello-Anmeldung sperrt das beim Scharfschalten
 * aus. 400 verlangt stattdessen schlicht "mfa" (Authenticator genuegt).
 *
 * Beide gewaehlten Vorlagen sind "Specific apps"-Vorlagen und liefern
 * includeApplications: ["None"] - ohne den Override unten wuerden sie sich
 * erfolgreich deployen und NICHTS tun.
 */
// Gemeinsamer Kern beider Varianten. Die MFA-Haelfte kommt je Variante dazu.
const DEVICE_FIRST_COMMON = [109, 201, 300, 301, 306, 401, 500, 501, 504, 505, 508, 509];

// Reihenfolge der Quell-Tiers: aadp1 zuerst (P1-Basis mit Geraeteoptionen),
// aadp1p2 als Rueckfall (dort liegt z.B. 109, ohne P2-Bedingungen zu nutzen).
const SELECTION_SOURCE_TIERS = ["aadp1", "aadp1p2", "bareMinimum"];

// Override fuer die Geraete-Haelfte - in beiden Varianten identisch.
const OVERRIDE_401 = {
  note: "Geltungsbereich auf alle Anwendungen; Externe vollstaendig ausgenommen - Gastgeraete sind im Tenant keine Objekte und koennen eine Compliance-Anforderung strukturell nicht erfuellen.",
  displayName: "401 - <RING> - Application protection - All apps: Require trusted device",
  applications: { includeApplications: ["All"] },
  excludeGuestsOrExternalUsers: {
    guestOrExternalUserTypes:
      "b2bCollaborationGuest,b2bCollaborationMember,b2bDirectConnectUser,b2bDirectConnectMember,serviceProvider,otherExternalUser",
    externalTenants: {
      "@odata.type": "#microsoft.graph.conditionalAccessAllExternalTenants",
      membershipKind: "all"
    }
  }
};

// Gruende, die in beiden Varianten gelten.
const EXCLUDED_COMMON = {
  110: "Verlangt phishing-resistente Auth ausgerechnet fuer die NOTFALLKONTEN. Ohne ausgerollte FIDO2-Schluessel sperrt sich damit genau das Konto aus, das im Notfall noch reinkommen muss. Aufnehmen, sobald Schluessel fuer die Break-Glass-Konten hinterlegt sind.",
  208: "\"Strong Auth ODER verwaltetes Geraet\" - der OR-Operator macht das Geraet zum Ersatz fuer MFA statt zur Ergaenzung. Waere schwaecher als ein Tenant, der heute schon MFA erzwingt.",
  307: "Sperrt den Device-Code-Fluss, ueber den das Onboarding und Reparieren dieses Tools selbst laeuft.",
  210: "Braucht ein angelegtes Nutzungsbedingungs-Objekt, sonst bleibt keine wirksame Kontrolle uebrig.",
  502: "Mobilgeraete: erst entscheiden, ob App-Schutzrichtlinien oder Geraetecompliance gelten sollen.",
  503: "Mobilgeraete: siehe 502.",
  506: "Mobilgeraete: siehe 502.",
  507: "Mobilgeraete: siehe 502."
};

const SELECTION_DEFS = {
  deviceFirst: {
    policies: [...DEVICE_FIRST_COMMON, 400].sort((a, b) => a - b),
    excluded: Object.assign({}, EXCLUDED_COMMON, {
      100: "Verlangt phishing-resistente Authentication Strength. In dieser Variante bewusst draussen - dafuer gibt es deviceFirstStrong.",
      104: "Wie 100 - Authentication Strength ohne Geraete-Alternative.",
      200: "Verlangt phishing-resistente Authentication Strength ohne Geraete-Alternative. 400 uebernimmt die MFA-Haelfte mit normaler MFA.",
      211: "Authentication Strength beim Geraete-Join. Faellt mit dem Verzicht auf starke Auth weg.",
      409: "Die Strong-Auth-Variante derselben Stelle - gehoert zu deviceFirstStrong, nicht hierher."
    }),
    overrides: {
      400: {
        note: "Geltungsbereich auf alle Anwendungen. Verlangt MFA (Authenticator genuegt) - ueberall, ohne Standortausnahme.",
        displayName: "400 - <RING> - Application protection - All apps: Require MFA",
        applications: { includeApplications: ["All"] }
      },
      401: OVERRIDE_401
    }
  },

  deviceFirstStrong: {
    policies: [...DEVICE_FIRST_COMMON, 409].sort((a, b) => a - b),
    excluded: Object.assign({}, EXCLUDED_COMMON, {
      400: "Verlangt nur \"mfa\". In dieser Variante uebernimmt 409 die MFA-Haelfte mit phishing-resistenter Stärke.",
      100: "Deckungsgleich mit 409 fuer Admin-Rollen - kann ergaenzt werden, sobald die Rollen-Abgrenzung gewuenscht ist.",
      104: "Privilegierte Systeme separat - erst aufnehmen, wenn der Geltungsbereich bewusst festgelegt ist.",
      200: "Traegt eine Standortausnahme (AllTrusted). Diese Zusammenstellung soll gerade nicht am Standort haengen.",
      211: "Authentication Strength beim Geraete-Join - sinnvoll, aber eigener Entscheid; nicht Teil der Grundlinie."
    }),
    overrides: {
      409: {
        note: "Geltungsbereich auf alle Anwendungen. Verlangt phishing-resistente Authentication Strength - setzt ausgerollte FIDO2-/Windows-Hello-Anmeldung voraus.",
        displayName: "409 - <RING> - Application protection - All apps: Require Strong Auth",
        applications: { includeApplications: ["All"] }
      },
      401: OVERRIDE_401
    }
  }
};

function policyNumberOf(policy) {
  const m = /^(\d{3})/.exec(String((policy && policy.displayName) || ""));
  return m ? Number(m[1]) : null;
}

// Baut eine Zusammenstellung aus den bestehenden Vorlagen, statt sie zu
// duplizieren - so bleibt sie bei einem Upstream-Abgleich automatisch in Sync.
function buildSelectionTier(key) {
  const def = SELECTION_DEFS[key];
  if (!def) throw new Error("Unbekannte Zusammenstellung: " + key);
  const pool = new Map();
  for (const tier of SELECTION_SOURCE_TIERS) {
    for (const policy of CA_POLICY_TEMPLATES[tier] || []) {
      const n = policyNumberOf(policy);
      if (n != null && !pool.has(n)) pool.set(n, policy);
    }
  }
  const out = [];
  for (const n of def.policies) {
    const src = pool.get(n);
    if (!src) throw new Error("Zusammenstellung " + key + ": Vorlage " + n + " nicht gefunden");
    const p = JSON.parse(JSON.stringify(src));
    const ov = def.overrides[n];
    if (ov) {
      if (ov.displayName) p.displayName = ov.displayName;
      if (!p.conditions) p.conditions = {};
      if (ov.applications) {
        p.conditions.applications = Object.assign({}, p.conditions.applications || {}, ov.applications);
      }
      if (ov.excludeGuestsOrExternalUsers) {
        p.conditions.users = Object.assign({}, p.conditions.users || {}, {
          excludeGuestsOrExternalUsers: ov.excludeGuestsOrExternalUsers
        });
      }
    }
    out.push(p);
  }
  return out;
}

const SELECTION_META = {};
for (const key of Object.keys(SELECTION_DEFS)) {
  CA_POLICY_TEMPLATES[key] = buildSelectionTier(key);
  SELECTION_META[key] = {
    policies: SELECTION_DEFS[key].policies,
    excluded: SELECTION_DEFS[key].excluded,
    overrides: Object.fromEntries(Object.entries(SELECTION_DEFS[key].overrides).map(([n, o]) => [n, o.note]))
  };
}

module.exports = { CA_POLICY_TEMPLATES, SELECTION_META };
