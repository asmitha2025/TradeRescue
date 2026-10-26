TradeRescue

A signed, replay-protected order relay that keeps working when the data connection doesn't.

When a trading app loses mobile data, you can't sell. TradeRescue adds an emergency channel: the order is packed into a compact HMAC-signed packet (about 85 characters, one SMS segment) and sent over the cellular radio, which often keeps working when mobile data and Wi-Fi don't. A backend verifies the packet and executes the order, enforcing limits on the server.

The trading use case is the demo. The engineering problem underneath is general: get an order through an unreliable channel exactly once, without trusting the channel.

Status: working prototype (Kotlin / Jetpack Compose + Firebase). See What is verified for exactly what has and hasn't been tested.


How it works
            online                              offline
Phone ──── HTTPS /order ────► Backend     Phone ── SMS ──► Twilio number ──► Cloud Function
                                          (signed packet)                    (verify → execute → confirm by SMS)
The packet

One format, shared by the Android app, the web UI and the Python reference implementation:

TRX|tx_id|user_id|action|symbol|qty|order_type|nonce|timestamp|signature
TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|30727513722d65e08ca55805de554550
signature is HMAC-SHA256 over the middle eight fields, truncated to 32 hex characters so the whole packet fits one SMS.
nonce and timestamp let the backend reject replayed packets.
Each holding has a pre-authorized emergency limit; the app won't queue more than that.
Channel selection

Decided at the moment the user enters their PIN:

Situation	What the app does
Online, backend set	POST /order over HTTPS
Offline, SMS number set, permission granted	Real SMS; waits for the radio to confirm it was accepted
Offline, SMS not usable, backend set	Posts the same signed packet to /emergency/sms
No backend set	Simulation mode: full flow and real signing, no network calls

The app states which path it used on screen instead of pretending.

Reliability design

The goal is that a packet can be lost, delayed, duplicated or tampered with, and the system still behaves safely.

Failure / threat	Mitigation
Data connection down	Fallback chain: HTTPS → SMS → HTTP fallback → simulation
Packet tampered in transit	HMAC-SHA256 signature verified server-side before anything executes
Packet replayed	nonce + timestamp checked by the backend; stale or reused packets are rejected
Oversized or runaway order	Per-holding emergency limit enforced on the backend (the app check is only a convenience)
Signature implementation drift across platforms	Signing pinned to a published HMAC test vector and cross-checked in Python, .NET and Web Crypto
Phone can't hear the result offline	UI says "Order sent", not "executed"; the backend confirms the fill by SMS

Design rule: the client is never trusted. Limits, signature, timestamp and nonce are all checked again on the server.

Backend

firebase/ contains a Cloud Function (with Firestore) that:

receives the SMS forwarded by Twilio,
verifies the signature, timestamp and nonce,
checks the per-holding emergency limit,
executes the sell in Firestore,
texts a confirmation back.

Once its URL is set in the app, the dashboard shows the server's holdings.

The packet reference implementation (app/packet.py) and the web UI (ui/index.html) live in the main TradeRescue project; this repo is the native Android companion. It exists for the one thing a web page can't do: call Android's SmsManager directly.

Build and run

Requirements: Android Studio (Koala or newer), or its bundled JDK plus the Android SDK. Min SDK 26.

bash
./gradlew :app:assembleDebug        # APK in app/build/outputs/apk/debug/
./gradlew :app:testDebugUnitTest    # packet + signing tests
./gradlew :app:installDebug         # onto a connected phone/emulator

On Windows use gradlew.bat. From a plain terminal, point JAVA_HOME at Android Studio's jbr folder and ANDROID_HOME at your SDK first. In Android Studio, just open the folder and press Run.

Settings (⚙ on the dashboard)
Backend URL: your deployed backend. Empty means simulation mode. Debug builds also accept plain http:// (http://10.0.2.2:8000 from an emulator, or your laptop's LAN IP from a phone).
SMS destination number: where the emergency SMS goes (your Twilio number, so the backend webhook receives it).

Both are saved across restarts. The same screen shows whether the data connection is up and whether SMS permission is granted.

Project structure
app/src/main/java/com/traderescue/app/
├── MainActivity.kt        entry point; requests SEND_SMS
├── AppViewModel.kt        screen state, connectivity, the execute() flow
├── data/
│   ├── Models.kt          Holding, EmergencyPacket
│   ├── PacketSigner.kt    HMAC-SHA256
│   ├── BackendApi.kt      OkHttp calls to /order and /emergency/sms
│   └── SmsSender.kt       SmsManager call + sent-status confirmation
└── ui/
    ├── Theme.kt           palette shared with the web UI
    └── Screens.kt         all 7 screens, matching the web flow
firebase/                  Cloud Function: verify, enforce limits, execute, confirm
app/src/test/.../PacketTest.kt   wire format, signature vectors, SMS size
What is verified, and what isn't

Verified

The project compiles, lint reports no errors, and the unit tests pass.
HMAC pinned against a published test vector.
The full wire packet matches a signature computed independently in .NET, plus earlier cross-checks against Python's hmac and the web UI's Web Crypto.

A single shared signing key means one leaked key compromises every user; per-device keys are the fix.
Roadmap
 Run end to end on a physical phone with a SIM and record the demo
 Per-device keys in Android Keystore
 Parse the confirmation SMS to close the "sent vs. executed" gap
 CI: run testDebugUnitTest on every push (GitHub Actions)
 Idempotency on tx_id documented and tested (duplicate delivery must not execute twice)
Author

Built by Asmitha M.
