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
can watch each one decide. The TRX2 format, the HMAC signing, the tx_id
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

The packet (version 2), identical in the Android app's `Models.kt` and the
backend's `packet.js`:

```
TRX2|tx_id|user_id|action|symbol|qty|order_type|floor|expires_at|nonce|timestamp|signature
TRX2|TRX0A1B2C|U10021|S|RELIANCE|5|I|148000|1700001800|deadbeef|1700000000|bb983dacfcd5053a247949e396fd4dcf
```

- `signature` is HMAC-SHA256 over the eleven preceding fields, truncated to
  32 hex characters. The version is field 0 and is signed, so a v1 `TRX`
  packet cannot be relabelled as v2 — it fails the signature check.
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

### Exactly once

`tx_id` is the idempotency key, and every field limit above is a character
budget rather than a preference: the longest packet the server will accept
is 146 characters, which is what keeps the one-segment guarantee a property
of the format instead of a habit of the current client.

1. **Signature first.** A forged or malformed packet produces a rejection
   log entry and nothing else. It can never create or claim a `tx_id`, so
   an attacker who learns a `tx_id` cannot burn it before the real device
   uses it.
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
│   ├── Models.kt          Holding, EmergencyPacket (the TRX2 format)
│   ├── PacketSigner.kt    HMAC-SHA256
│   ├── BackendApi.kt      OkHttp calls to /order and /emergency/sms
│   └── SmsSender.kt       SmsManager call + sent-status confirmation
└── ui/
    ├── Theme.kt           same palette as ui/index.html
    └── Screens.kt         all 7 screens, matching the web flow
app/src/test/.../PacketTest.kt   wire format, signature vectors, SMS size
```

## What is verified, and what isn't

Only what a test actually produced is claimed here.

**Verified by tests that run in this repo** — 58 backend tests
(`npm test` in `firebase/functions`) and 12 Android unit tests
(`gradlew.bat :app:testDebugUnitTest`), all passing:

- The HMAC matches a published test vector, and the full v2 wire packet
  matches a signature pinned independently in both the Kotlin and the
  JavaScript test suites, so a format change on either side fails a test on
  that side.
- The longest packet the server's own shape checks will accept is 146
  characters, inside one 160-character GSM-7 segment. This is asserted
  against the limits themselves, not against a sample packet.
- A v1 `TRX` packet is refused, and relabelling one as `TRX2` fails the
  signature check.
- Exactly-once, on the terms described above: a replay returns the stored
  result; a `tx_id` reused with different bytes is a conflict; a forged
  packet creates no ledger record; a duplicate arriving after expiry gets
  the original fill; ten concurrent copies of one packet produce one
  execution and nine identical replays.
- Every terminal outcome is replayed rather than re-decided — a refusal
  stays refused even after the price rises above the floor or the clock
  comes back into range.

**Important caveat on where those proofs hold.** The guarantees above are
proven against `MemoryStore`, the in-memory store adapter, which serializes
transactions to model what Firestore provides. `FirestoreStore` implements
the same interface and is a direct transposition of the original
transaction, but **it has not been run against the Firestore emulator**, so
nothing here demonstrates that the deployed function behaves identically.
Treat the exactly-once claim as proven for the logic and untested for the
production store.

- **TODO (Phase 6, CI):** a Firestore emulator smoke test that runs the
  duplicate, late-duplicate and concurrent-copies cases through
  `FirestoreStore`. Until that exists, the caveat above stands.

**Not verified at all:**

- The app has not been run on a device or emulator from this build, and the
  real-SMS path has not been exercised on a phone with a SIM.
- No real broker is involved. "Executes" means a row changes in a simulated
  ledger. Exactly-once is a property of **that ledger**; it says nothing
  about whether a real broker API would double-fill, since a real broker
  has not been called.
- The failure lab (Phase 2) is not written yet, so no number here comes
  from running thousands of packets — only from the named tests above.

## Known limits (deliberate, for a demo)

- The signing secret and PIN are constants in source — one secret shared by
  every install. Phase 3 replaces it with a key provisioned per device at
  enrollment and held in the Android Keystore, unlocked by biometrics or the
  device credential. Note that the signature stays an HMAC, so the server
  necessarily holds a copy of each device's key and could forge that
  device's packets; what the Keystore protects is use of the key on the
  phone, not its secrecy from the backend. Asymmetric signatures would fix
  that and are out of scope: an ECDSA P-256 signature is 128 hex characters,
  which puts the packet at roughly 204 and breaks the one-segment
  guarantee.
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
