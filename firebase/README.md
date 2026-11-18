# TradeRescue — Firebase backend

Receives the emergency SMS (through a Twilio number), verifies the signed
packet, and executes the sell in Firestore.

```
Phone ── SMS ──► Twilio number ── webhook ──► Cloud Function `api` ──► Firestore
  ▲                                                │
  └────────── confirmation SMS ("SOLD 5 RELIANCE…") ┘
```

What the function checks, in this order:

1. **The HMAC signature matches** (packet not forged or altered). Nothing
   that fails here reaches the ledger or claims a `tx_id`.
2. **The `tx_id` has not been decided already.** If it has, and the packet
   is byte-identical, the stored outcome is returned and nothing executes a
   second time. If the bytes differ, it is a conflict, not a replay.
3. **The packet has not expired** — `expires_at`, or 15 minutes after its
   timestamp, whichever is sooner — and its clock is not more than two
   minutes ahead of ours.
4. **The user holds enough shares**, within the pre-authorized emergency
   limit, and the price is at or above the packet's floor if it set one.

Steps 2 to 4 and the holdings update run in one Firestore transaction.
Every outcome of a validly signed packet is written as terminal, refusals
included, so a retry is answered from the record rather than re-decided.

The architecture that makes this testable: `packet.js` parses and
authenticates, `engine.js` applies a sell, `service.js` holds every
decision against a store interface, `store.js` provides that interface over
either Firestore or an in-memory map, and `index.js` is only HTTP. Nothing
below `index.js` imports firebase-admin, so the whole decision path runs in
a unit test. See the caveat in the root README about which store the
guarantees are proven on.

## What appears in Firestore

| Collection | Document | Contents |
|---|---|---|
| `users` | `U10021` | `holdings` map — the share quantities that drop when a sell executes |
| `orders` | the `tx_id`, e.g. `TRX25517F` | the ledger: `status` (`FILLED`, `EXPIRED`, `BELOW_FLOOR`, `OVER_LIMIT`, …), `packetHash`, symbol, quantity, fill price, proceeds, `channel` (`SMS`, `DIRECT`, `HTTP_FALLBACK`), sender's number, time, and the stored `outcome` a retry is answered with |
| `rejections` | auto-id | packets refused before the ledger: forged, malformed, or claiming another order's `tx_id` |

The `nonces` collection is gone. It was the v1 replay guard; `tx_id` plus
the packet hash replaced it, and `nonce` is now only signature entropy. A
reset still sweeps the old collection so a deployment carrying v1 documents
gets cleaned.

## Endpoints

Base URL after deploy: `https://asia-south1-<project-id>.cloudfunctions.net/api`

| Method and path | Used by |
|---|---|
| `POST /webhook/twilio-sms` | Twilio, when an SMS arrives. Replies with the confirmation SMS. |
| `POST /emergency/sms` | The app's HTTP fallback (same packet as plain text). |
| `POST /order` | The app when online. |
| `GET /portfolio/U10021` | The app's dashboard. |
| `GET /admin/overview` | The admin dashboard. Needs the `x-admin-key` header. |
| `POST /demo/reset` | The dashboard's "Reset demo" button. Needs the admin key. Restores the portfolio and deletes orders and rejected packets. |

## Admin dashboard

`admin/index.html`, served by Firebase Hosting at
`https://<project-id>.web.app` after deploy. It refreshes every 2 seconds
and shows:

- portfolio value, orders filled, orders received by SMS, packets rejected
- each holding with shares left out of the starting amount
- every order: time, stock, quantity, fill price, channel, sender (masked)
- every refused order and the reason, split into packets stopped before
  the ledger (forged or malformed) and orders refused on the rules
  (expired, over limit, below floor)

![Admin dashboard](../docs/admin-dashboard.png)

It asks for the admin key on first open. The key is `demo-admin` unless
you set your own — **do that before deploying**: create `functions/.env`
containing `ADMIN_KEY=<something long and random>`. To skip typing it,
bookmark `https://<project-id>.web.app/#key=<your key>`.

The same site also serves the API under `/api`, so
`https://<project-id>.web.app/api` works as the app's Backend URL too.

## Run locally (no account, no cost)

```
cd firebase/functions
npm install
npm test
cd ..
firebase emulators:start --only functions,firestore,hosting --project demo-traderescue
```

Needs Java on PATH for the Firestore emulator (Android Studio's `jbr\bin`
works). Then:

- Admin dashboard: http://127.0.0.1:5000/#key=demo-admin
- API base URL: `http://127.0.0.1:5000/api`
- Raw database view: http://127.0.0.1:4000

## Demo without deploying (laptop + tunnel)

Twilio can only call a public URL. Without a cloud deploy, a tunnel gives
the backend running on your laptop a temporary public address:

```
Phone ── SMS ──► Twilio ──► https://<random>.trycloudflare.com ──► laptop:5000 ──► function + Firestore emulator
```

One command does all of it — starts the backend, opens the tunnel, and
sets the Twilio number's incoming-SMS webhook to the new address:

```
cd firebase
.\start-demo.ps1
```

It prints the dashboard link and the Backend URL to paste into the app.
The Twilio step runs only if `TWILIO_ACCOUNT_SID` and `TWILIO_NUMBER` are
set in the environment (the Auth Token is then asked for); with a second
phone in Gateway mode it is skipped. The address changes on every run, so
update the app's Backend URL each time. The laptop must stay on and
online for the whole demo. Orders are kept in `emulator-data/` between
runs.

## Second phone as the SMS gateway (no Twilio, no international SMS)

Any Android phone with a SIM can stand in for Twilio:

```
Phone A (offline) ── SMS ──► Phone B (Gateway mode, online) ──► POST /webhook/sms-forward ──► sell
        ▲                                │
        └──────── confirmation SMS ──────┘
```

On phone B: install the same app, set the Backend URL in ⚙ Settings, tap
Save, then reopen Settings and switch on **Gateway mode** and grant the
SMS permissions. On phone A: set the SMS number to phone B's number.

Phone B only forwards texts that start with `TRX2|`; other messages are
ignored. It cannot forge or change an order, because the backend verifies
the packet's signature. `/webhook/sms-forward` accepts JSON
`{"from": "...", "text": "..."}`, so a third-party SMS-forwarding app
works too.

## Deploy

1. Create a Firebase project at https://console.firebase.google.com.
2. Upgrade it to the **Blaze** plan — Cloud Functions cannot be deployed on
   the free Spark plan. Demo usage stays inside the free allowance, but a
   billing card is required.
3. In the console: Build → Firestore Database → Create database
   (location `asia-south1`, production mode).
4. From this folder:
   ```
   firebase use --add          # pick the project
   firebase deploy --only functions,firestore:rules,hosting
   ```
5. Copy the function URL it prints, open it in a browser — you should see
   `{"service":"TradeRescue","status":"ok"}`.
6. In the app: ⚙ → Backend URL → paste that URL → Save. The dashboard
   should say "Live from server".

## Connect Twilio

1. Create a Twilio account and get a phone number that can **receive SMS**.
2. Phone Numbers → your number → Messaging → "A message comes in":
   Webhook, `POST`, `<function URL>/webhook/twilio-sms`.
3. In the app: ⚙ → SMS destination number → the Twilio number, with
   country code.
4. On a trial account, verify your own phone number in Twilio, or the
   confirmation reply will not be delivered.

Check before the demo: Twilio does not offer ordinary Indian numbers for
inbound SMS, so the number will most likely be a US one. Sending to it from
an Indian SIM is an international SMS — it costs a few rupees and some
prepaid plans block it. Send one test text first.

## Demo limits

- The signing secret is the shared demo constant. Set `SIGNING_SECRET` in
  `functions/.env` to change it (and change the app to match).
- `/order` and `/portfolio` are open to anyone with the URL. Fine for a
  demo; a real service would require a logged-in user.
- The admin dashboard is protected by one shared key, not per-person
  logins.
- The Twilio webhook does not verify Twilio's own request signature. The
  packet's HMAC is what authorizes an order, so a forged webhook call
  cannot sell anything without the key.
- Fills use the stored price; there is no market feed.
