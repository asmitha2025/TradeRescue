# TradeRescue

**A pre-authorized emergency exit for investors on unreliable networks:
orders are armed online, triggered over SMS, expire if they arrive late,
and are proven never to execute twice.**

A trading app with no data connection cannot sell. TradeRescue adds a
second channel: the order becomes a 116-character signed packet and goes
out as a real SMS over the cellular radio, which survives a great deal that
mobile data does not.

The trading use case is the demo. The engineering problem underneath is
general: **get an order through an unreliable channel exactly once, without
trusting the channel.**

> Status: working prototype (Kotlin / Jetpack Compose + Firebase). See
> [What is verified](#what-is-verified-and-what-isnt) for exactly what has
> and has not been tested.


---

## The scenario

Meena runs a small shop outside Nashik. Most of her savings are in three
stocks. The market opens badly, and she needs out of one position before it
gets worse.

Her phone shows full signal and no data. The tower is congested, the
monsoon has taken a backhaul link, and her broker's app sits on a spinner.
By the time it loads, the price she wanted is gone.

What she has is SMS. It needs far less of the network to work, and it keeps
working when data does not.

So TradeRescue sends the order as a text. That raises three problems, and
the whole design is the answer to them:

| Problem | Why it is hard | Answer |
|---|---|---|
| One SMS is 160 characters | A JSON order does not fit | A pipe-separated format with a per-field character budget |
| SMS is unauthenticated | Anyone can text the number | HMAC signature from a key held in Meena's phone, released by her fingerprint |
| SMS is store-and-forward | Copies arrive late, twice, or out of order | `tx_id` idempotency, and an expiry the server enforces |

Meena resends the text because she never saw a confirmation. The second
copy does not sell a second time — it returns the original fill. The
confirmation that comes back is signed, so a text from anyone else claiming
"SOLD" is shown as an unverified message and never as a sale.

---

## Results

Everything below was produced by running the commands in this repo. No
number here is written by hand.

| | |
|---|---|
| Backend tests | **113** passing (`npm test` in `firebase/functions`) |
| Firestore emulator scenarios | **8** passing, against real transactions |
| Android unit tests | **26** passing |
| Android instrumented tests | **14** passing, on a device |
| Demo page checks | **36** passing |
| Self-check mutations caught | **7 of 7** |
| Lint | clean |

**Failure lab** — 50,000 packets over 5 seeds, under drops, duplicates,
concurrent duplicates, reordering, delays past expiry, tampering, `tx_id`
conflicts, clock skew, and five key faults:

```
23,232 filled + 14,471 refused + 31,947 replayed + 13,874 pre-ledger = 83,524 deliveries
```

All **8 invariants** held on every seed, and every expiry boundary case
matched. Full report: [docs/failure-lab.md](docs/failure-lab.md).

The lab is only worth that much because `tools/lab-selfcheck.js` breaks the
service seven ways on purpose and fails unless the matching check fires. A
lab that cannot fail is not evidence.

### Bugs that testing found

Each of these was live in code that looked correct and had passing tests:

| Bug | Found by |
|---|---|
| The shape regexes permitted a 190-character packet, so the one-segment guarantee rested on convention | a worst-case Kotlin test |
| `SmsGatewayReceiver` filtered on the old version prefix and would have silently dropped every packet | a grep after a version bump |
| The response sub-key was serialised into the HTTP fallback's JSON, handing any caller what it needs to forge confirmations | writing a test that the outcome carries no key material |
| A replayed confirmation was stamped with the send time, so a retry produced a second signed message attesting a new time for an old event | a replay test comparing bytes |
| The dashboard double-counted refused orders | the Firestore emulator suite |
| One duplicate in eight failed with `INVALID_ARGUMENT` instead of its replay, under contention | a contention probe against the emulator |
| **The StrongBox fallback never worked**, so enrollment crashed on every device without a secure element | instrumented tests on a real emulator |
| A self-check mutation had gone stale and was silently testing nothing | the self-check's own control run |
| Six invariants all passed while one order's result was handed to a *different* order reusing its `tx_id` | the self-check's `conflict-as-replay` mutation |

## Reliability design

A packet can be lost, delayed, duplicated, reordered or tampered with, and
the system still has to behave safely. This table came from an earlier
version of this README; the mitigations are what the branch now actually
does, and the right-hand column says where each one is proven.

| Failure or threat | Mitigation | Proven by |
|---|---|---|
| Data connection down | HTTPS → SMS → HTTP fallback → simulation, decided when the user authorises | manual checklist |
| Packet tampered in transit | HMAC-SHA256 over every field, checked before anything else happens | 113 backend tests, lab invariant 3 |
| Packet duplicated | `tx_id` is the idempotency key; a duplicate replays the stored outcome instead of executing | lab invariants 1 and 8, 8 emulator scenarios |
| Duplicate arrives after expiry | The `tx_id` lookup runs **before** the expiry check, so a late copy gets the original fill rather than "expired" | lab invariant 2, emulator scenario |
| Same `tx_id`, different order | SHA-256 of the packet is stored beside it; a mismatch is a conflict, never another order's result | lab invariant 6 |
| Packet arrives too late | `expires_at`, capped at `timestamp + 15 min` so a packet cannot grant itself more life | lab, boundary cases at ±1s |
| Phone's clock is wrong | Two-minute skew backstop; a packet from the future is refused | lab invariant, unit tests |
| Device stolen or retired | Per-device keys, revocable immediately; rotation keeps the old key for one packet lifetime and no longer | 23 key tests, lab invariant 7 |
| A key signs for the wrong account | The trading account comes from the session claim, not from the packet | enrollment tests |
| Confirmation SMS forged | The server signs replies with a separate sub-key; an unverifiable reply shows as "Unverified message", never as a fill | unit + instrumented tests |
| Confirmation reflected as an order | Separate request and response sub-keys, so a reply **is not** a valid order signature | unit tests, lab fault |
| Oversized or runaway order | Per-holding emergency limit, enforced on the server; the app's check is only a convenience | unit tests, lab invariant 5 |
| Signature drift across platforms | The same HKDF sub-keys and signature pinned in Node, Kotlin **and** the browser | 3-way pinned tests |

Design rule: **the client is never trusted.** Every limit, signature,
expiry, key status and account check runs again on the server, which
assumes the phone is lying.

---

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

### Enrolling a device

A device has to be enrolled before it can sign anything, and enrollment
needs the network — which is the point of doing it ahead of time. A phone
that has never enrolled cannot sign an emergency order, and the moment it
needs one is exactly when it cannot enroll.

Enrollment requires **two** things, and neither is a constant in source:

1. **A signed-in session.** A Firebase Auth ID token, verified with
   `checkRevoked` so signing out stops it working at once. The trading
   account id comes from a custom claim rather than from the caller: a
   Firebase uid is 28 characters and the packet's `user_id` field allows
   12, so a session without a valid claim is refused outright rather than
   truncated into somebody else's portfolio.
2. **A one-time code.** Six digits, minted by an already signed-in
   session, valid ten minutes, single use, stored only as a SHA-256 hash
   and spent atomically. The session says who is asking; the code says
   *this particular device* was authorised by a human looking at a
   signed-in screen.

Requiring both means a leaked session cannot silently add a device, and a
code is useless to anyone not signed in. A code that never existed, one
already spent and one expired all get the same refusal, because telling
them apart would tell an attacker which guesses landed.

**Three active devices per account.** Rotated and revoked keys do not
occupy a slot, so rotation costs nothing and revoking frees one. Past the
limit, enrollment is refused with instructions rather than silently.

Every event — code issued, device enrolled, rotated, revoked, and each
refusal with its reason — is written to an audit log naming who did it. The
log holds no secrets and no code hashes, and a demo reset does not sweep it.

A service built without an authenticator refuses every key-lifecycle
request rather than waving them through. Failing closed is the only safe
default for the operation that creates signing keys, and there is a test
that it does.

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

**The app** (`./gradlew` on macOS and Linux, `gradlew.bat` on Windows):

```
gradlew.bat :app:assembleDebug             # APK in app/build/outputs/apk/debug/
gradlew.bat :app:installDebug              # onto a connected phone/emulator
gradlew.bat :app:testDebugUnitTest         # 26 JVM tests: format, HKDF, confirmations
gradlew.bat :app:lintDebug
gradlew.bat :app:connectedDebugAndroidTest # 14 Keystore tests, needs a device
```

`connectedDebugAndroidTest` needs a **screen lock set** on the device or
emulator (`adb shell locksettings set-pin 1234`): without one the Keystore
cannot hold a key that requires user authentication, and the tests that
check that requirement are meaningless.

**The backend, the demo and the lab:**

```
cd firebase/functions && npm test          # 113 tests, no install needed
node demo/check-demo.js                    # 36 checks on the demo page
node tools/lab-selfcheck.js                # prove the lab still catches breakage
node tools/failure-lab.js                  # 50,000 packets over 5 seeds
cd firebase && npm --prefix functions run test:emulator   # 8 scenarios on real Firestore
```

Run `lab-selfcheck` **before** trusting `failure-lab`: if the self-check
fails, the lab has a blind spot and its green result means nothing. The
emulator test needs Java on the PATH.

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
- **Session token** and **Enrollment code** — the two credentials
  enrollment needs. Neither is persisted: the token is a credential and the
  code is single use. See "Enrolling a device" above for why the app asks
  you to paste them rather than showing a sign-in screen.

Both are saved across restarts. The same screen shows whether the data
connection is up and whether SMS permission is granted.


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
│   ├── PacketSigner.kt    random material for packets
│   ├── BackendApi.kt      OkHttp calls to /enroll, /order, /emergency/sms
│   ├── SmsGatewayReceiver.kt  inbound SMS: confirmations and gateway mode
│   └── SmsSender.kt       SmsManager call + sent-status confirmation
└── ui/
    ├── Theme.kt           the shared palette
    └── Screens.kt         every screen, including the four confidence states
app/src/test/.../PacketTest.kt         26 JVM tests
app/src/androidTest/.../KeystoreDeviceKeysTest.kt   14 on-device tests

firebase/functions/
├── packet.js        format, signature, confirmations — no I/O, no state
├── keys.js          HKDF sub-key derivation
├── auth.js          sessions: FirebaseSessionAuth | MemorySessionAuth
├── engine.js        applying a sell to a holdings map — pure
├── service.js       every decision, against the interfaces below
├── store.js         FirestoreStore | MemoryStore
├── keystore.js      SecretManagerKeyStore | MemoryKeyStore
├── index.js         HTTP only: parse, call one method, shape the reply
├── test/            113 unit tests
└── emulator-test/   8 scenarios against real Firestore + a contention probe

tools/
├── failure-lab.js   50,000 packets through the real logic under fault injection
└── lab-selfcheck.js breaks the service 7 ways and checks the lab notices
```

Nothing below `index.js` imports firebase-admin, which is what lets the
whole decision path run in a unit test with a virtual clock.

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
service seven ways on purpose — removing the tx_id lookup, ignoring
expiry, trusting every signature, treating a conflicting tx_id as a
replay, accepting revoked and long-rotated keys, skipping the enrollment
session check, and making enrollment codes reusable — and
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

**Verified by tests that run in this repo** — 113 backend tests
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
- Enrollment: an unauthenticated caller is refused; a replayed code is
  refused; an expired code is refused and one at the last second of its
  life still works; a code minted for another account is refused; three
  devices racing one code produce exactly one enrollment; the device limit
  holds and revoking frees a slot; one account cannot revoke or rotate
  another's device; and a service with no authenticator refuses everything.
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
- **The app has no sign-in screen.** The backend requires a real
  Firebase Auth session and a one-time code, and that enforcement is
  tested. What is missing is the Android side of it: wiring the Firebase
  Auth SDK needs a configured project and a `google-services.json` this
  repo does not carry, so Settings takes a pasted session token and the
  six-digit code instead. The protocol is real; the way the app obtains
  those two strings is not built.
- **`FirebaseSessionAuth` has never run against the real Firebase Auth.**
  Like `SecretManagerKeyStore`, it is written to the same interface as the
  tested memory adapter, and the memory adapter is what every enrollment
  test exercises.
- The failure lab's numbers come from `MemoryStore`. The emulator suite is
  the cross-check against real Firestore, but it is eight scenarios, not
  fifty thousand packets.


## Roadmap

From the earlier README, with what this branch closed ticked off:

- [x] Per-device keys in the Android Keystore
- [x] Parse the confirmation SMS to close the "sent vs executed" gap
- [x] CI: run the tests on every push (GitHub Actions)
- [x] Idempotency on `tx_id`, documented and tested — duplicate delivery
      must not execute twice
- [ ] Run end to end on a physical phone with a SIM and record the demo
      ([docs/manual-test.md](docs/manual-test.md) is the checklist)
- [ ] A sign-in screen in the app, so the session token and enrollment code
      are not pasted in
- [ ] Asymmetric packet signatures, so the server cannot forge a device's
      orders — needs a signature that fits one SMS segment

---

## Known limits (deliberate, for a demo)

- The PIN on the confirm screen is a constant in source. It is a
  speed bump in front of the biometric prompt, not a credential; the thing
  that actually authorises an order is the device key, released by a
  fingerprint or the device credential. See "Per-device keys" above,
  including the part about the server being able to forge a device's
  packets.
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

---

## Author

Built by [Asmitha M](https://github.com/asmitha2025).
