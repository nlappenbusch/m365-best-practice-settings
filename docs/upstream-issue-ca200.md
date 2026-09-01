# Upstream-Meldung: Policy 200 — displayName verspricht eine Geräte-Alternative, die es nicht gibt

Ziel: <https://github.com/AlexFilipin/ConditionalAccess> · Stand 01.09.2026 ·
Betrifft Branch `master`, `PolicyRepository/Base protection/`

Unten der fertige Text zum Einstellen als GitHub-Issue. Bewusst als **Issue**,
nicht als PR: die Policy-Logik ist korrekt, es geht ausschliesslich um die
Benennung — und wie der Maintainer sie auflösen will (Name anpassen vs.
Geräte-Alternative ergänzen), ist seine Designentscheidung, nicht unsere.

---

## Titel

`Policy 200: displayName promises "or trusted device" but grantControls contain no device option`

## Body

**Summary**

Policy 200 is named `All apps: Require Strong Auth or trusted device or trusted
location`, but its `grantControls.builtInControls` is an empty array. The only
grant control in effect is the `authenticationStrength`
(`00000000-0000-0000-0000-000000000004`, phishing-resistant MFA), plus the
location carve-out via `excludeLocations: ["AllTrusted"]`.

There is no device alternative in the policy. The name promises one.

**To be explicit about what is *not* being reported here**

The policy body itself is fine. `builtInControls: []` alongside a set
`authenticationStrength` is the normal representation — policies 100, 104, 110,
202, 204, 211, 409 and 602 all use exactly that shape. Adding
`["compliantDevice","domainJoinedDevice"]` would be actively harmful: the
operator is `OR`, so every additional control is an additional *way in*. A
compliant device would then satisfy the policy without any MFA at all, which is
weaker than what 200 enforces today.

So this is a naming bug, not a policy bug. The policy is stricter than its name
suggests.

**Why it matters anyway**

Anyone reading the policy set by name — which is how these get reviewed and
signed off in practice — will believe a device path exists and is covered. It
isn't. Conversely, someone spotting the empty `builtInControls` may "fix" it in
the weakening direction described above, in good faith, because the name tells
them the array should not be empty. That is the failure mode worth closing off.

The exposure is not marginal: 200 ships in both the `Bare minimum` and
`Category structure for AADP1` policy sets, so it is in the default path for
anyone adopting the blueprint.

**Comparison within the repository**

| Policy | `builtInControls` | `authenticationStrength` | Name matches behaviour? |
|---|---|---|---|
| 200 | `[]` | `…0004` | ❌ claims "or trusted device" |
| 208 | `["compliantDevice","domainJoinedDevice"]` | `…0004` | ✅ |
| 201 | `["mfa","compliantDevice","domainJoinedDevice"]` | — | ✅ |
| 109 | `["compliantDevice","domainJoinedDevice"]` | — | ✅ |
| **211** | `[]` | `…0004` | ✅ named `Require Strong Auth or trusted location` |

Policy 211 is the decisive one: identical construction to 200 — empty
`builtInControls`, same authentication strength, trusted-location carve-out —
and it is named `Require Strong Auth or trusted location`, with no device claim.
The repository already has a convention for this exact shape; 200 is the single
policy that departs from it.

Policy 208 is effectively "200 with a genuine device alternative", and is named
accordingly (`Require Strong Auth or trusted device`, no location clause).

**Suggested resolution**

Rename 200 to follow the 211 convention:

```diff
- 200 - <RING> - Base protection - All apps: Require Strong Auth or trusted device or trusted location
+ 200 - <RING> - Base protection - All apps: Require Strong Auth or trusted location
```

This leaves behaviour untouched and makes the name honest.

If the intent was in fact to offer a device path in this slot, then 208 already
covers it and the two should probably be reconciled — but that is a design call,
which is why this is filed as an issue rather than a PR.

**Note for adopters, since renaming has a side effect**

Tooling that upserts policies keyed on `displayName` will treat a renamed policy
as new and create a second one alongside the existing entry. Worth a line in the
release notes if the rename is accepted.

---

## Was wir lokal gemacht haben

Wir haben 200 in `api/lib/conditionalAccessPolicies.js` (alle drei Tiers) und in
der lokalen `ca-policies/`-Ablage auf den 211-konformen Namen gezogen.
`grantControls` blieben unangetastet. Der Vermerk dazu steht im Dateikopf von
`conditionalAccessPolicies.js`, damit der nächste Upstream-Abgleich die
Korrektur nicht als Transkriptionsfehler zurückrollt.
