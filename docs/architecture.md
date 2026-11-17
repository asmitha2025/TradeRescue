# Architecture

One page on how an order gets from a phone with no data connection to a
ledger entry that cannot be written twice.

---

## The problem

A trading app is useless the moment it loses data. Mobile data is the first
thing to go in a power cut, a flood, a crowded stadium or a patchy rural
cell. The cellular voice/SMS channel survives much of that, because it
needs far less of the network to work.

So: carry the order over SMS. That raises three problems at once, and the
whole design is the answer to them.

| Problem | Why it is hard | Answer |
|---|---|---|
| An SMS is 160 characters | A JSON order does not fit | A fixed pipe-separated format with a per-field character budget |
| SMS is unauthenticated | Anyone can text the number | HMAC signature from a per-device key |
| SMS is store-and-forward | Copies arrive late, twice, or out of order | `tx_id` idempotency and an expiry the server enforces |

---

## The request path

```
  PHONE                          NETWORK                      SERVER
  ─────                          ───────                      ──────

  online once:
  enroll ──────────── HTTPS ──────────────────────────────▶ issue device secret
         ◀─────────── secret (hex), key id ────────────────
  derive req/resp sub-keys, import into Keystore,
  overwrite the secret

  offline, later:
  build TRX3 packet
  biometric / PIN ──▶ sign with the REQUEST sub-key
         │
         ├── SMS ──▶ Twilio number ──webhook──┐
         │                                     ├──▶ Cloud Function
         └── (HTTP fallback when a SIM is absent) ┘        │
                                                           ▼
                                                   format → key → signature
                                                   → tx_id → expiry/limits
                                                   → execute in a transaction
                                                           │
         ◀────── SMS, signed with the RESPONSE sub-key ◀───┘
  verify the tag, and only then show "Executed"
```

The HTTP fallback exists for an emulator or a device with no SIM. It is the
same signed packet over a different pipe, decided by exactly the same code.

---

## The check order

This is the part worth arguing about, because the *order* carries almost
all of the guarantees. From `service.js`:

```
1. format      enough to read the key id, trusting nothing else
2. the key     unknown, revoked, or rotated past its grace → stop
3. signature   forged or tampered → stop
4. tx_id       already decided? return that decision, unchanged
5. expiry, action, order type, clock skew, holdings, limit, floor
6. execute     inside one transaction with the holdings update
```

Two placements do real work:

**Steps 1–3 before anything is recorded.** Nothing that fails them may
create a ledger entry or claim a `tx_id`. If a forgery could claim one, an
attacker who learned a `tx_id` could burn it before the real device used
it, and the genuine order would come back as a conflict.

**Step 4 before step 5.** Once a `tx_id` has an outcome, that outcome is
the answer forever. A duplicate arriving a day late gets the **original
fill**, not "expired" — which is the behaviour a user actually needs, since
the copy that arrives late is usually the one they resent because they
never saw a confirmation.

A refusal in step 5 is *also* terminal. It is written to the ledger and
replayed verbatim on a retry, so a packet refused for being below its floor
stays refused even if the price recovers a minute later. The packet had its
chance; re-deciding it would make the answer depend on when a network
happened to deliver a copy.

---

## The key hierarchy

```
            device secret (32 bytes, server-issued at enrollment)
                 │
      HKDF-SHA256, empty salt
                 │
        ┌────────┴────────┐
        │                 │
   info "TRX3-req"   info "TRX3-resp"
        │                 │
   REQUEST sub-key   RESPONSE sub-key
   signs orders      signs confirmations
   phone: Keystore,  phone: Keystore, no auth
   auth every use    server: signs replies
   server: verifies
```

**Why two keys rather than one.** With a single key, a confirmation SMS is
a validly signed message from the right key — so an attacker who could get
one resent to the server might have it read as an order. Separate sub-keys
make that impossible by construction rather than by a check: a confirmation
tag simply *is not* a valid order signature, and no code has to remember
the case exists.

**Why the request key needs the user and the response key does not.**
Signing an order moves money, so the Keystore demands a fingerprint or the
device credential every single time. Verifying a confirmation authorises
nothing and happens whenever the network delivers an SMS, with nobody
watching — requiring authentication there would mean confirmations silently
failing to verify while the phone sat in a pocket.

**The honest limit.** This is an HMAC, so the server holds a copy of every
device's secret and could forge that device's packets. The Keystore
protects *use* of the key on the phone, not its secrecy from the backend.
Asymmetric signatures would fix that; an ECDSA P-256 signature is 128 hex
characters and pushes the packet to ~204, breaking the one-segment
guarantee. Recorded as future work, not quietly skipped.

---

## Where each invariant is enforced

| Invariant | Enforced by | Proven by |
|---|---|---|
| One fill per `tx_id` | the order document is keyed on `tx_id`; read-and-write in one transaction | failure lab, and the emulator smoke test against real Firestore |
| A replay returns the original result | the stored `outcome` is returned verbatim when the packet hash matches | both, plus unit tests |
| A different payload never gets another order's result | SHA-256 of the packet stored beside the `tx_id`; a mismatch is a conflict | lab invariant 6 |
| No fill after `expires_at` | `min(expires_at, timestamp + 15 min)`, checked in `decide()` | lab, boundary cases at ±1s |
| No fill from a bad signature | `verifyParsed` before any ledger access | lab invariant 3 |
| No fill from a dead key | `resolveKey` before the signature check | lab invariant 7 |
| Holdings never negative | `applySell` inside the transaction | lab invariant 5 |
| Packet fits one SMS segment | per-field character limits in `packet.js` | asserted against the limits, both ends |
| A reply cannot be forged | HMAC with the response sub-key | unit + instrumented tests |

Nothing on that list is enforced on the phone. The app checks the same
limits so it can show a useful error, but every one of them is re-checked
on the server, which assumes the client is lying.

---

## How it is built, and why

```
firebase/functions/
  packet.js    format, signature, confirmations — no I/O, no state
  keys.js      HKDF sub-key derivation
  engine.js    applying a sell to a holdings map — pure
  service.js   every decision, against two interfaces — no firebase imports
  store.js     FirestoreStore | MemoryStore
  keystore.js  SecretManagerKeyStore | MemoryKeyStore
  index.js     HTTP only: parse, call one method, shape the reply
```

The seam matters more than it looks. `index.js` calls `initializeApp()` at
module load, so before the split nothing in the decision path could be
required from a test without credentials. Now `service.js` takes a store, a
key store and a clock, which is what lets 50,000 packets run through the
real logic in three seconds, with expiry driven by a virtual clock instead
of a fifteen-minute wait.

The same discipline on the phone: `DeviceKeys` is an interface with a
Keystore implementation and an in-memory fake, so the derivation, the
format and confirmation verification are all unit-testable on the JVM.

---

## What is actually proven, and what is not

| | |
|---|---|
| 91 backend tests | the logic, on `MemoryStore` |
| 8 emulator scenarios | the same guarantees on **real Firestore transactions** |
| 26 Android unit tests | derivation, format, confirmation verification |
| 14 instrumented tests | the real Android Keystore, on a device |
| 36 demo checks | the browser reimplementation agrees |
| 50,000 packets, 8 invariants, 5 seeds | under drops, duplicates, reordering, tampering, conflicts, clock skew and five key faults |

Two habits keep those numbers honest. The failure lab works out expiry and
packet identity **itself** rather than importing the functions it is
checking — a checker that borrows the arithmetic under test cannot see a
bug in it. And `lab-selfcheck.js` breaks the service five ways on purpose
and fails unless the matching invariant fires, because a lab that cannot
fail is not evidence.

Still not proven: `SecretManagerKeyStore` has never run against the real
API, no real broker is involved (so exactly-once is a property of *this
ledger*, not of a brokerage), and no packet in any test has crossed a
cellular network. `docs/manual-test.md` is the checklist for that last one.
