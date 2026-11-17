# TradeRescue — Android

When a trading app loses its data connection, you can't sell. TradeRescue
adds an emergency channel: the order is packed into a compact, HMAC-signed
packet (107 characters, and never more than 146) and sent as a real SMS
over the cellular radio, which keeps working when mobile data and Wi-Fi
don't. Orders expire if they arrive late, and the ledger is keyed so that
one order executes at most once however many copies turn up.

This is the native companion to `ui/index.html` in the main project. It
exists for the one thing a web page cannot do: call Android's `SmsManager`
directly.

## Try it without a phone

[demo/index.html](demo/index.html) is a single-page interactive demo: the
phone, the security engine and the admin dashboard side by side. Turn the
phone's data off, sell, and watch the signed SMS get checked and land on
the dashboard. Open the file in any browser, or publish the repo with
GitHub Pages.

**It is a simulation of the server checks, not the backend running in your
browser.** The page contains a second implementation in JavaScript that
mirrors `firebase/functions/` — the same checks in the same order — so you
can watch each one decide. The TRX3 format, per-device keys and their two
HKDF-derived sub-keys, the HMAC signing, the tx_id
ledger, expiry, limits and the floor behave as the real server does; the
SMS hop, Firestore and the exchange are simulated, the ledger lives in the
tab and resets with the page, and no broker is involved.

Because it is a second implementation, the demo proves nothing by itself.
Each button corresponds to a backend test that does:

| Button | What it shows | Proven by |
|---|---|---|
| **Resend the same SMS** | Exactly-once: the duplicate returns the original result and the holding does not move | `the same tx_id with the same bytes replays the stored result`, and `ten concurrent copies of a packet fill once and replay the identical result` |
| **Tampered replay** | Same `tx_id`, a different order, correctly signed → conflict, never executed | `the same tx_id with different bytes is a conflict, not someone else's result` |
| **Forge a packet** | Quantity changed after signing → refused, and no `tx_id` is claimed | `a forged packet is refused, recorded, and changes nothing`, and `a forgery cannot burn the tx_id the real device is about to use` |
| **Expired packet** | Signed correctly but 20 minutes late → refused, and the refusal is terminal | `a packet first seen after its expiry is refused`, and `an expired refusal is not re-decided if the clock comes back in range` |
| **Over the limit** | More shares than the pre-authorized emergency limit → refused | `each refusal for a validly signed packet is stored and replayed verbatim` (the `OVER_LIMIT` case) |

All of those live in `firebase/functions/test/service.test.js` and run with
`npm test`.

## How it works

```
            online                         offline
Phone ──── HTTPS /order ────► Backend      Phone ── SMS ──► Twilio number ──► Backend
                                           (signed packet)   /webhook/twilio-sms
```

The packet (version 3), identical in the Android app's `Models.kt` and the
backend's `packet.js`:

```
TRX3|key_id|tx_id|user_id|action|symbol|qty|order_type|floor|expires_at|nonce|timestamp|signature
TRX3|a1b2c3d4|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000|80882aab5f00c74589a2271b52679701
```

- `key_id` names the device key that signed this packet. The server reads
  it before it checks anything else, because it cannot check a signature
  without knowing which key to check against. It is inside the signed
  payload, so a packet cannot be pointed at a different device's key.
- `signature` is HMAC-SHA256 over the twelve preceding fields, truncated to
  32 hex characters, using this device's **request sub-key** (below). The
  version is field 0 and is signed, so an older `TRX` or `TRX2` packet
  cannot be relabelled as v3.
- `order_type` is `I`: immediate-or-cancel. The emergency path fills at the
  available price or not at all. Nothing rests, because a resting order is
  the wrong shape for an exit you need *now*.
- `floor` is an optional price floor in **paise**, `0` meaning "exit at any
  price". Integers keep the comparison off floating point on both sides.
  The floor is the user's choice; no floor is the honest default for an
  emergency exit, since a floor that does not fill is no exit at all.
- `expires_at` is when the order stops being executable. It is the primary
  protection against a late SMS. The server takes whichever comes first of
  `expires_at` and `timestamp + 15 minutes`, so a packet cannot grant
  itself a longer life than the server allows.
- `timestamp` is now only a clock-skew backstop: a packet more than two
  minutes in the future is refused.
- `nonce` is signature entropy. It is no longer a replay guard — `tx_id` is
  (see below).
- Each holding has a pre-authorized emergency limit, enforced on the server
  as well as in the app.

### Per-device keys

There is no secret shared by every install. A device enrolls once while
online, over HTTPS, and the server hands it a 32-byte secret. Both ends
then derive **two sub-keys** from it with HKDF-SHA256 under direction
labels:

| Sub-key | Label | Signs | User present? |
|---|---|---|---|
| request | `TRX3-req` | order packets, on the phone | yes, every time |
| response | `TRX3-resp` | confirmations, on the server | n/a |

The split is what makes a reflected confirmation harmless. A reply signed
with the response key simply **is not** a valid order signature, so it
cannot be fed back in as an order — no check has to remember to look for
that case. The same holds in reverse: a message signed with the request key
is not a confirmation the app will believe.

On the phone both sub-keys go into the Android Keystore, StrongBox-backed
where the hardware supports importing such a key. The device secret itself
is never stored: it lives in memory long enough to derive the two sub-keys
and is then overwritten. The request sub-key requires user authentication
on **every** use — biometric **or** the device credential, because a phone
with no enrolled fingerprint, or a wet thumb in the rain, must still have
an emergency exit. The response sub-key requires none: a confirmation
arrives whenever the network feels like it, there is no user to prompt, and
reading one authorises nothing.

**The server holds every device's key and could forge that device's
packets.** This is an HMAC, so the server must hold the same secret to
verify a signature. What the Keystore protects is *use* of the key on the
phone — nobody who picks it up can sign an order without your face or your
PIN — not its secrecy from the backend. Asymmetric signatures would remove
that trust and are out of scope: an ECDSA P-256 signature is 128 hex
characters, which pushes the packet to roughly 204 and breaks the
one-segment guarantee. Noted as future work.

### Revocation and rotation

Both online only.

- **Revocation** is immediate, with no grace period. A revoked key's
  packets are refused exactly the way a forgery is.
- **Rotation** issues a new key and starts a grace window on the old one of
  one maximum packet lifetime (15 minutes). A packet already in flight was
  signed in good faith, and SMS is store-and-forward, so cutting the key
  off at the instant of rotation would throw away honest orders. The
  boundary is tested at the second and is **inclusive**, matching
  `expires_at`.
- Unknown, revoked and expired-rotated keys, and a genuine key signing for
  a different user, are all refused **before the ledger**: no `tx_id`
  claimed, a rejection log entry and nothing else.

### Signed confirmations

The server signs its reply with the device's response sub-key:

```
TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060 #3186ddf82c2b14ca
TradeRescue: NOT SOLD (EXPIRED) Ref TRX0A1B2C 1700000060 #a0c1...
```

The app verifies the tag before it changes anything on screen. Only then
does the status move from **Sent** to **Executed**. A reply that arrives
but does not verify is shown as **"Unverified message"** and is never
allowed to read as a fill — anybody who knows the phone number can send a
text, and only the broker can sign one.

The reply had to shrink to make room for the tag, and now carries epoch
seconds rather than a formatted date: a localised string is a poor thing to
sign, varying by server locale and able to carry characters that push the
message out of GSM-7 into two segments. The app renders a friendly time
from it. Longest possible confirmation is 123 characters.

Reading those replies needs `RECEIVE_SMS`, which Google Play treats as a
**restricted permission**: fine for a portfolio project installed by
sideload, not shippable to the Play Store as-is.

### Exactly once

`tx_id` is the idempotency key, and every field limit above is a character
budget rather than a preference: the longest packet the server will accept
is 151 characters, which is what keeps the one-segment guarantee a property
of the format instead of a habit of the current client. (`key_id` cost 8
characters plus a separator when TRX3 added it; the nonce paid most of that
back, dropping from 16 to 12.)

1. **The key, then the signature.** The key id is read first, because a
   signature cannot be checked without knowing which key to check against.
   An unknown, revoked or long-rotated key stops there. A forged or
   malformed packet stops at the signature. Either way it produces a
   rejection log entry and nothing else, and can never create or claim a
   `tx_id` — so an attacker who learns a `tx_id` cannot burn it before the
   real device uses it.
2. **Then the `tx_id` lookup.** A `tx_id` already on the ledger replays its
   stored outcome. Same `tx_id` with different bytes (matched on a SHA-256
   of the packet) is a conflict, and gets an error rather than somebody
   else's order.
3. **Then expiry, limits and the floor.** Every outcome for a validly
   signed packet is stored as terminal — filled, expired, below floor, over
   limit — and replayed verbatim on a retry.
4. **Then execution**, inside one transaction with the holdings update.

Step 2 sitting before step 3 is the part that matters: a duplicate arriving
a day late gets the **original fill**, not "expired". Ten copies of one
packet racing each other produce one execution and nine identical
replays.

Channel selection, decided at the moment you enter your PIN:

| Situation | What the app does |
|---|---|
| Online, backend set | `POST /order` over HTTPS |
| Offline, SMS number set, permission granted | Real SMS; waits for the radio to confirm it was accepted |
| Offline, SMS not usable, backend set | Posts the same signed packet to `/emergency/sms` |
| No backend set | Simulation mode — full flow, real signing, no network calls |

## Backend

A Firebase backend lives in [firebase/](firebase/README.md): a Cloud
Function that receives the SMS from Twilio, verifies the packet and
executes the sell in Firestore, then texts a confirmation back. Once its
URL is set in the app, the dashboard shows the server's holdings.

## Build and run

Requirements: Android Studio (Koala or newer) or just its bundled JDK plus
the Android SDK. Min SDK 26.

```
gradlew.bat :app:assembleDebug        # APK in app/build/outputs/apk/debug/
gradlew.bat :app:testDebugUnitTest    # packet + signing tests
gradlew.bat :app:installDebug         # onto a connected phone/emulator
```

From a plain terminal, point `JAVA_HOME` at Android Studio's `jbr` folder
and `ANDROID_HOME` at your SDK first. In Android Studio, just open the
folder and press Run.

## Settings (⚙ on the dashboard)

- **Backend URL** — your deployed backend. Empty means simulation
  mode. Debug builds also accept plain `http://` so you can point at a
  laptop: `http://10.0.2.2:8000` from an emulator, or your laptop's LAN IP
  from a phone.
- **SMS destination number** — where the emergency SMS goes (your Twilio
  number, so the backend's `/webhook/twilio-sms` receives it).

Both are saved across restarts. The same screen shows whether the data
connection is up and whether SMS permission is granted.

## Demo script (about two minutes)

1. Open the app. Point out the green **Online** pill — it reflects the
   phone's real connectivity.
2. Tap **Emergency Sell → RELIANCE → 5 → PIN 1234**. Order goes over HTTPS.
3. Turn on airplane mode, then re-enable only the cellular radio — or just
   tap the pill to rehearse an outage ("Offline · test").
4. Repeat the sell. The Executing screen shows each step and the exact
   signed packet that goes over the air, with its character count.
5. On a phone with a SIM and an SMS number set, show the message in the
   phone's own Messages app — that is the proof it left over the radio.

Without a SIM (emulator, tablet) step 5 uses the HTTP fallback or
simulation, and the app says so on screen rather than pretending.

## Structure

```
app/src/main/java/com/traderescue/app/
├── MainActivity.kt        entry point; requests SEND_SMS
├── AppViewModel.kt        screen state, connectivity, the execute() flow
├── data/
│   ├── Models.kt          Holding, EmergencyPacket (the TRX3 format)
│   ├── Hkdf.kt            HKDF-SHA256 sub-key derivation
│   ├── DeviceKeys.kt      Keystore-held per-device keys (+ memory fake)
│   ├── Confirmation.kt    parses and verifies the server's signed reply
│   ├── PacketSigner.kt    HMAC-SHA256
│   ├── BackendApi.kt      OkHttp calls to /order and /emergency/sms
│   └── SmsSender.kt       SmsManager call + sent-status confirmation
└── ui/
    ├── Theme.kt           same palette as ui/index.html
    └── Screens.kt         all 7 screens, matching the web flow
app/src/test/.../PacketTest.kt   wire format, signature vectors, SMS size
```

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | one page on the request path, the check order, the key hierarchy, and where each invariant is enforced |
| [docs/failure-lab.md](docs/failure-lab.md) | the latest failure-lab run, regenerated by the script |
| [docs/manual-test.md](docs/manual-test.md) | the end-to-end checklist a machine cannot run: real SIM, real biometrics, both SMS routes |
| [docs/decisions.md](docs/decisions.md) | why a few odd-looking choices are the way they are |

## Failure lab

A reliability claim is worth what its evidence is worth, so the claims above
are checked by pushing a large population of packets through the real
verify/execute path while an unreliable network does its worst to them.

```
node tools/lab-selfcheck.js     # first: prove the lab still catches a broken service
node tools/failure-lab.js       # then: 5 seeds x 10,000 packets
```

The lab **runs the service logic in-process on `MemoryStore`** with a virtual
clock — the same signature check, tx_id lookup, expiry arithmetic and
holdings transaction the deployed function runs. **It does not exercise the
real SMS network, Firestore, or a broker.** No packet crosses a radio, no
transaction reaches Google, and no share changes hands.

Faults injected: dropped, duplicated (sequentially and concurrently, up to
ten copies racing in the same instant), reordered, delayed past expiry,
tampered with after signing, a second correctly signed packet reusing a
tx_id for a different order, a client clock running ahead both inside and
beyond the two-minute backstop, and five key faults — a revoked key, a
never-enrolled key, another device's key, a packet in flight across a
rotation both inside and outside the grace window, and a server
confirmation fed back in as if it were an order. A clean control group is included,
because a lab that only ever sees broken deliveries proves nothing about
working ones.

Latest run — the full output, including per-fault counts and the outcome
distribution, is in [docs/failure-lab.md](docs/failure-lab.md), regenerated
by the command above:

| | |
|---|---|
| Packets | 50,000 across 5 seeds (base seed `20261117`) |
| Deliveries processed | 83,524 |
| First-time decisions, **filled** (shares sold) | **23,232** |
| First-time decisions, refused (on the ledger, nothing sold) | 14,471 |
| Replays served (no new decision) | 31,947 |
| Stopped before the ledger (forged, conflicting or a dead key) | 13,874 |
| Dropped before arrival | 3,323 |
| Runtime | 12.9s |
| Invariants | **all 8 held on all 5 seeds** |
| Boundary cases | **all matched** |

The eight invariants are checked against the **final ledger**, not against
what each call returned: at most one fill per tx_id; no fill where server
time passed `expires_at`; no fill from an invalid signature; no conflicting
packet executed; only one payload per tx_id ever answered, with others
refused as conflicts; holdings never negative and final holdings exactly
initial minus the sum of fills; and every replay identical to the stored
outcome; and no fill from a revoked, unknown or wrong-direction key.

`expires_at` is **inclusive**: the server refuses when
`now > min(expires_at, timestamp + 15 minutes)`, so a packet arriving in the
same second as its expiry is still executable. The lab asserts that boundary
explicitly at one second before, exactly at, and one second after, on every
seed.

### Why the self-check exists

A lab that cannot fail is not evidence. `tools/lab-selfcheck.js` breaks the
service five ways on purpose — removing the tx_id lookup, ignoring expiry,
trusting every signature, treating a conflicting tx_id as a replay, and
accepting revoked and long-rotated keys — and
fails if the matching invariant does not fire. It also runs the unmutated
code first and fails if the lab reports problems with healthy code.

That self-check earned its place immediately: it found that the original six
invariants all passed while a server handed one order's stored result to a
*different* order reusing its tx_id. Nothing executed twice, holdings were
untouched, and the replay did match the record it had been wrongly copied
from, so every check stayed quiet. The seventh invariant exists because of
that hole.

It paid for itself a second time in Phase 3. The `trust-signature` mutation
had gone stale when parsing and verification were split into two functions:
it patched a function the service no longer called, so it broke nothing,
caught nothing, and still reported a pass. A self-check that silently stops
testing is worse than none, which is why it now runs the unmutated code
first and fails if the lab is quiet when it should not be.

## What is verified, and what isn't

Only what a test actually produced is claimed here.

**Verified by tests that run in this repo** — 91 backend tests
(`npm test` in `firebase/functions`), 8 Firestore emulator scenarios
(`npm --prefix functions run test:emulator`), 26 Android unit tests
(`gradlew.bat :app:testDebugUnitTest`), 14 instrumented Keystore tests
(`gradlew.bat :app:connectedDebugAndroidTest`) and 36 demo-page checks
(`node demo/check-demo.js`), all passing, plus `lintDebug` clean:

- The HKDF derivation is pinned to the same two sub-key values in **three
  independent implementations** — Node's `hkdfSync`, Kotlin's `Hkdf.kt` and
  the demo page's WebCrypto — so the phone, the server and the demo cannot
  drift apart silently.
- The full v3 wire packet matches a signature pinned in both the Kotlin and
  the JavaScript test suites, so a format change on either side fails a
  test on that side.
- The longest packet the server's own shape checks will accept is 151
  characters, inside one 160-character GSM-7 segment, asserted against the
  limits themselves rather than a sample packet. The longest possible
  signed confirmation is 123.
- Older `TRX` and `TRX2` packets are refused, and relabelling one fails.
- Exactly-once: a replay returns the stored result; a `tx_id` reused with
  different bytes is a conflict; a forged packet creates no ledger record;
  a duplicate arriving after expiry gets the original fill; ten concurrent
  copies produce one execution and nine identical replays.
- Every terminal outcome is replayed rather than re-decided — a refusal
  stays refused even after the price rises above the floor or the clock
  comes back into range.
- Keys: an unknown, revoked or expired-rotated key is refused before the
  ledger and claims no `tx_id`; a genuine key signing for another user is
  refused; an order signed with the response sub-key is refused; the
  rotation grace boundary is checked at one second before, exactly at, and
  one second after.
- An outcome never serialises key material, so the HTTP fallback cannot
  hand a caller the key needed to forge confirmations.
- A confirmation verifies only against the right device's response sub-key:
  altered text, a wrong tag, a missing tag, another device's key and the
  request sub-key are each refused, and an unverifiable reply is never
  shown as a fill.

**The store caveat is now closed.** Earlier versions of this file said the
guarantees were proven on `MemoryStore` only, and that `FirestoreStore` was
an untested transposition. It is tested now:

```
cd firebase && npm --prefix functions run test:emulator
```

Eight scenarios run against the real Admin SDK and the Firestore emulator —
ten concurrent copies of one packet, a sequential duplicate, a `tx_id`
conflict, a packet first seen after expiry, a duplicate arriving a day
late, a forgery, four concurrent orders contending on one holdings
document, and the admin totals. **All 8 pass**, and they run in CI on every
push.

That exercise was worth doing. Two bugs only it could find:

- The dashboard was **double-counting refused orders**. A below-floor
  packet was written to the ledger *and* logged as a rejection, and the
  dashboard added the two together, so one refused order displayed as two.
  The rejections log now holds only packets stopped before the ledger, and
  `recordRejection` throws if anything else is passed to it.
- Under contention, roughly **one trial in eight** had a duplicate copy
  fail with `INVALID_ARGUMENT: Transaction is invalid or closed` instead of
  receiving its replay. Exactly-once held throughout — there was never more
  than one fill — so this was availability, not safety. `FirestoreStore`
  now retries transient transaction failures with jittered backoff, which
  is safe precisely because the operation is idempotent. Twelve further
  trials of ten concurrent copies: no errors.

**The Android Keystore caveat is also closed.** 14 instrumented tests run
the real Keystore on a device:

```
gradlew.bat :app:connectedDebugAndroidTest
```

They cover key import, that the device secret itself is never stored, that
a key inside the Keystore produces the exact signature the backend expects,
that the key material cannot be read back out, that the two sub-keys are
genuinely different keys, confirmation verification, and that the request
key requires user authentication while the response key does not.

They found a bug that would have shipped: the StrongBox fallback caught
`StrongBoxUnavailableException`, which is what the Keystore throws when
*generating* a key. When **importing** one — which is what this app does —
a device without a secure element throws a plain
`java.security.KeyStoreException` instead. The fallback never fired, so
**enrollment crashed on every device without StrongBox**, which is most of
them. No JVM test could have found it.

Last run: Android 16 emulator, all 14 passing, reporting
`security level = software` (expected on an emulator with no hardware
keymaster — a real phone reports TEE or StrongBox) and
`userAuthenticationRequired = true`.

**Not verified at all:**

- **No packet in any test has crossed a cellular network.** The real-SMS
  path has not been exercised on a phone with a SIM, and neither route
  (Twilio, or a second phone as gateway) has been run end to end.
  [docs/manual-test.md](docs/manual-test.md) is the checklist for that,
  with an empty results table.
- **The biometric prompt has not been tested by a human.** The instrumented
  tests assert the authentication *flag* is set on the key, because an
  automated test has nobody to present a fingerprint. Whether cancelling
  the prompt really sends nothing is step 2.3 of the manual checklist.
- **`SecretManagerKeyStore` has never run against the real API.** It is
  written to the same interface as the tested memory adapter, and that is
  all that can be said for it. The deployed function logs a warning and
  falls back to in-process keys when no project is configured, which is
  useless in production and deliberately obvious.
- **No real broker is involved.** "Executes" means a row changes in a
  simulated ledger. Exactly-once is a property of **that ledger**; it says
  nothing about whether a real brokerage API would double-fill.
- **The enrollment token is not authentication.** Anyone holding it can
  enroll a device for any user id. Phase 4's login replaces it.
- The failure lab's numbers come from `MemoryStore`. The emulator suite is
  the cross-check against real Firestore, but it is eight scenarios, not
  fifty thousand packets.


## Known limits (deliberate, for a demo)

- The PIN is a constant in source, and so is the enrollment token. The
  token is this demo's stand-in for the authenticated session a real
  deployment would require before handing a device a key: **it is not
  authentication**, and anyone holding it can enroll a device for any user.
  Phase 4's login is what replaces it. The per-device signing keys
  themselves are real — see "Per-device keys" above, including the part
  about the server being able to forge them.
- On the SMS channel the app shows **Order sent**, not *executed*: the
  radio confirmed the message, but the fill is confirmed by the backend,
  which an offline phone can't hear from. Phase 3 closes that loop with a
  server-signed confirmation SMS the app verifies before it says
  *executed*. That needs `RECEIVE_SMS`, which Google Play treats as a
  restricted permission: fine for a portfolio project run by sideload, not
  shippable to the Play Store as-is.
- Holdings and prices are demo data held in memory.
- Google Play restricts `SEND_SMS` to default SMS apps and a few approved
  use cases, so this would ship by sideload/enterprise distribution, or
  hand off to the system SMS composer instead.
