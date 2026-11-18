# Manual end-to-end test

Everything in this repo that a machine can check, a machine does check: 91
backend tests, 26 Android unit tests, 36 demo checks, 8 Firestore emulator
scenarios, and a failure lab over 50,000 packets. None of it puts a packet
on a cellular network, and none of it asks a human for a fingerprint.

This checklist covers what is left. Work through it on a real phone with a
real SIM, and fill in the results table at the bottom — including the
failures, which are the useful part.

**Nothing here has been run yet.** The table is empty on purpose.

---

## 0. Before you start

| | |
|---|---|
| Phone A | the trader's phone. Has the app, a SIM, a screen lock, ideally a fingerprint |
| Phone B | only for Route 2. Any Android phone with the app and a SIM |
| Backend | deployed, or the emulator reachable from the phone |

```
# Build and install
gradlew.bat :app:installDebug

# The instrumented Keystore tests (device or emulator, needs a screen lock set)
gradlew.bat :app:connectedDebugAndroidTest

# Their report lands in:
#   app/build/reports/androidTests/connected/debug/index.html
```

Run `connectedDebugAndroidTest` **first**. If the Keystore tests fail there
is no point going near a SIM, and two of them print the security level the
key actually got:

```
TradeRescue: request key security level = StrongBox | TEE (StrongBox unavailable, fell back) | software
TradeRescue: userAuthenticationRequired = true
```

Record that line in the table — it is the only place the StrongBox outcome
for your hardware is visible.

> A device with **no secure lock screen** cannot hold a key that requires
> user authentication. Set a PIN before running, or
> `signingWithAnAuthRequiringKeyIsRefusedRatherThanSilentlyWeakened` will
> print a warning and the auth requirement will not have been tested.

---

## 1. Enrollment (online)

| # | Step | Expected |
|---|---|---|
| 1.1 | Open the app, go to **⚙ Settings**, set the **Backend URL** | saved, survives a restart |
| 1.2 | With data on, tap **Enroll this device** | status becomes `Enrolled as <8 hex chars>` |
| 1.3 | Check the backend logs or key store | a device record exists for that key id |
| 1.4 | Turn data **off**, tap **Enroll this device** | button disabled, "Enrollment needs a data connection" |
| 1.5 | Reopen Settings | still shows the key id; enrollment survived the app restart |

**What this is checking:** the one moment a device secret crosses the
network, and that it only ever does so over HTTPS with the network up.

> The enrollment token is a constant in source and is **not**
> authentication. Anyone with it can enroll a device for any user. This is
> a known hole, recorded in the README, and Phase 4's login is what closes
> it. Do not deploy this to a real brokerage.

---

## 2. Authorising an order (biometrics / device credential)

| # | Step | Expected |
|---|---|---|
| 2.1 | Start an emergency sell, reach the point of sending | a biometric prompt appears |
| 2.2 | Cancel the prompt | "The order was not signed, so nothing was sent." No SMS leaves |
| 2.3 | Check the phone's own Messages app | **no** message in the outbox for the cancelled attempt |
| 2.4 | Repeat, authenticate with a fingerprint | the packet is built and sent |
| 2.5 | Repeat, authenticate with the **PIN/pattern** instead | also works — this is the fallback that stops a wet thumb locking you out |
| 2.6 | On the Executing screen, read the packet | starts `TRX3|`, ≤160 characters, key id matches Settings |

**What this is checking:** that an unauthorised order genuinely sends
nothing, and that the device-credential fallback works. 2.3 is the one that
matters: it is the difference between refusing to sign and sending anyway.

---

## 3. Route 1 — Twilio

```
Phone A ──SMS──► Twilio number ──webhook──► Cloud Function ──SMS──► Phone A
```

Set the **SMS destination number** in Settings to the Twilio number.

| # | Step | Expected |
|---|---|---|
| 3.1 | Turn on airplane mode, then re-enable **cellular only** (no data) | app shows **Offline** |
| 3.2 | Emergency sell → authorise | log shows "Signed with this device's key", then "SMS accepted by the network" |
| 3.3 | Phone A's Messages app | the `TRX3|…` packet in the sent folder — this is the proof it left over the radio |
| 3.4 | Screen state immediately after | **"Order sent"**, not "Order executed" |
| 3.5 | Twilio console | inbound message received, webhook returned 200 |
| 3.6 | Admin dashboard | the order appears, status `FILLED`, channel `SMS` |
| 3.7 | Wait for the reply SMS | arrives on Phone A |
| 3.8 | Screen state after the reply | flips to **"Order executed"**, shows the server's confirmation text |
| 3.9 | Read the raw reply | `TradeRescue: SOLD … Ref … <epoch> #<16 hex>`, one segment |
| 3.10 | **Resend the same SMS** (forward the sent message again) | reply is **byte-identical** to 3.7; dashboard still shows **one** order; holdings unchanged |

**3.10 is the whole project in one step.** If the second reply differs, or
a second order appears, exactly-once is broken on real infrastructure.

### 3b. The negative cases

| # | Step | Expected |
|---|---|---|
| 3.11 | From **another phone**, text `TradeRescue: SOLD 99 RELIANCE @Rs1.00 (0 left) Ref TRXFAKE01 1700000000 #0000000000000000` to Phone A | app shows **"Unverified message"**, never a fill |
| 3.12 | From another phone, text a copied `TRX3|…` packet with one digit of the quantity changed | dashboard shows a rejection, `BAD_SIGNATURE`, no order |
| 3.13 | Wait >15 minutes, then resend an **unused** packet | refused, `EXPIRED`, nothing sold |
| 3.14 | Revoke the key (`POST /keys/revoke`), send a fresh order | refused, `REVOKED_KEY`, no order on the ledger |
| 3.15 | Re-enroll, send an order | works again with the new key id |

3.11 is the one worth doing carefully. The message is designed to look
exactly like a fill. If the app ever shows it as one, the signed
confirmation work is worthless.

---

## 4. Route 2 — phone as gateway

```
Phone A ──SMS──► Phone B (gateway mode) ──HTTPS──► Cloud Function
                      │
Phone A ◄────SMS──────┘
```

No Twilio. Phone B receives the SMS on an ordinary SIM, forwards it to the
backend over its own data connection, and texts the reply back.

Set Phone A's **SMS destination number** to Phone B's number, and turn on
**Gateway mode** in Phone B's settings.

| # | Step | Expected |
|---|---|---|
| 4.1 | Phone B: enable gateway mode with a Backend URL set | status line shows it is listening |
| 4.2 | Phone A offline, send an emergency sell | Phone B's status line logs the forwarded packet |
| 4.3 | Admin dashboard | order appears, channel `SMS` |
| 4.4 | Phone A | receives the signed reply, screen flips to **Executed** |
| 4.5 | Phone B: text it something that is not a packet | ignored, nothing forwarded |
| 4.6 | Phone B: turn gateway mode off, send again from A | nothing forwarded; A stays on "Order sent" |

**What this is checking:** the route that needs no Twilio account at all,
which is the one that actually works in a village with one friend's phone.

> Phone B needs `RECEIVE_SMS`, a **restricted permission** on Google Play.
> Fine by sideload, not shippable to the Play Store as-is.

---

## 5. SMS cost and registration in India

Worth knowing before the demo, and worth saying out loud in an interview.

**Route 2 (phone as gateway) has no regulatory overhead.** It is one
person texting another person. Cost is whatever the SIM plan charges for a
domestic SMS — on most Indian plans, bundled and effectively free. For a
portfolio project this is the route to demonstrate.

**Route 1 (Twilio) does have overhead, and it is substantial:**

- **TRAI DLT registration is mandatory** for A2P (application-to-person)
  SMS to Indian numbers. The sender must register as a Principal Entity on
  a DLT portal (Jio, Airtel, Vodafone Idea and BSNL each run one),
  register the Header (sender id) and register every message **template**.
  Unregistered or template-mismatched traffic is dropped by the operator,
  not merely delayed.
- **Templates are a real constraint on this design.** A DLT template is
  fixed text with a limited number of variable fields. The confirmation
  format — fixed prose plus variables for quantity, symbol, price, tx id,
  timestamp and the signature tag — has to be registered as a template and
  then followed exactly. Changing the wording means re-registering.
- **Inbound is the easier direction.** Receiving SMS on a Twilio Indian
  number is not DLT-registered in the same way, but Twilio requires
  regulatory bundles and address proof for Indian long codes, and
  availability of inbound-capable Indian numbers varies.
- **Cost**, as a rough order of magnitude and worth re-checking at the
  time: outbound A2P SMS to India is of the order of a few paise to a
  rupee per message depending on operator and route, plus a monthly number
  rental. Inbound is usually cheaper or free. A demo of a few dozen
  messages costs very little; the registration effort, not the per-message
  price, is the real barrier.
- **Trial accounts** can only message verified numbers, which is enough
  for a demo but will silently drop anything else.

> Do not take the numbers above as current. They move, and they vary by
> operator. Check Twilio's India pricing page and the DLT portal on the
> day. What does not move is the shape of it: Route 2 is free and
> unregulated, Route 1 needs paperwork.

---

## Results

Fill in as you go. Record failures verbatim — a half-remembered symptom is
worth nothing later.

| Section | Date | Device / Android version | Result | Notes |
|---|---|---|---|---|
| 0 — instrumented tests | | | | security level reported: |
| 1 — enrollment | | | | |
| 2 — authorisation | | | | |
| 3 — Twilio route | | | | |
| 3b — negative cases | | | | |
| 4 — gateway route | | | | |

### Anything that failed

| # | What happened | Expected | Fixed in |
|---|---|---|---|
| | | | |

### Not tested, and why

| What | Why |
|---|---|
| | |
