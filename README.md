# TradeRescue — Android

When a trading app loses its data connection, you can't sell. TradeRescue
adds an emergency channel: the order is packed into a compact, HMAC-signed
packet (about 85 characters) and sent as a real SMS over the cellular
radio, which keeps working when mobile data and Wi-Fi don't.

This is the native companion to `ui/index.html` in the main project. It
exists for the one thing a web page cannot do: call Android's `SmsManager`
directly.

## How it works

```
            online                         offline
Phone ──── HTTPS /order ────► Backend      Phone ── SMS ──► Twilio number ──► Backend
                                           (signed packet)   /webhook/twilio-sms
```

The packet, identical across the Android app, the web UI and `app/packet.py`:

```
TRX|tx_id|user_id|action|symbol|qty|order_type|nonce|timestamp|signature
TRX|TRX0A1B2C|U10021|S|RELIANCE|5|M|deadbeef|1700000000|30727513722d65e08ca55805de554550
```

- `signature` is HMAC-SHA256 over the middle eight fields, truncated to 32
  hex characters so the whole packet fits one SMS segment.
- `nonce` and `timestamp` let the backend reject replays.
- Each holding has a pre-authorized emergency limit; the app never lets you
  queue more than that.

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

- **Backend URL** — your deployed FastAPI backend. Empty means simulation
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
│   ├── Models.kt          Holding, EmergencyPacket
│   ├── PacketSigner.kt    HMAC-SHA256
│   ├── BackendApi.kt      OkHttp calls to /order and /emergency/sms
│   └── SmsSender.kt       SmsManager call + sent-status confirmation
└── ui/
    ├── Theme.kt           same palette as ui/index.html
    └── Screens.kt         all 7 screens, matching the web flow
app/src/test/.../PacketTest.kt   wire format, signature vectors, SMS size
```

## What is verified, and what isn't

- **Verified:** the project compiles, lint reports no errors, and the unit
  tests pass. The tests pin the HMAC against a published test vector and
  the full wire packet against a signature computed independently in .NET,
  on top of the earlier cross-checks against Python's `hmac` and the web
  UI's Web Crypto implementation.
- **Not yet verified:** the app has not been run on a device or emulator
  from this build, and the real-SMS path has not been exercised on a phone
  with a SIM. Do a full run-through on the demo phone before presenting.

## Known limits (deliberate, for a demo)

- The signing secret and PIN are constants in source. A real build would
  provision a per-device key into the Android Keystore and verify the PIN
  (or biometrics) against something the server controls.
- On the SMS channel the app shows **Order sent**, not *executed*: the
  radio confirmed the message, but the fill is confirmed by the backend,
  which an offline phone can't hear from. Reading the broker's reply SMS
  would close that loop.
- Holdings and prices are demo data held in memory.
- Google Play restricts `SEND_SMS` to default SMS apps and a few approved
  use cases, so this would ship by sideload/enterprise distribution, or
  hand off to the system SMS composer instead.
