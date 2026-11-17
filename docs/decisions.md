# Decisions

Short notes on choices that look odd without the reason. Each one is here
because a later reader — including me — would otherwise be tempted to
"clean it up" and break something.

---

## `androidx.fragment` is pinned forward

**`app/build.gradle.kts`**

```kotlin
implementation("androidx.biometric:biometric:1.1.0")
implementation("androidx.fragment:fragment-ktx:1.8.2")
```

The fragment dependency is not used directly by any code in this app. It is
pinned because `biometric:1.1.0` transitively brings in `fragment:1.2.x`,
which predates the `ActivityResult` APIs.

`MainActivity` already used `registerForActivityResult` for the `SEND_SMS`
permission. With the old fragment on the classpath, `lintDebug` fails with
`InvalidFragmentVersionForActivityResult`, and the underlying problem is
real rather than a lint pedantry: fragment 1.2.x does not call
`super.onRequestPermissionsResult()` and uses request codes that collide
with the ones the ActivityResult machinery issues, so permission callbacks
can be delivered to the wrong place.

`MainActivity` also had to become a `FragmentActivity`, because
`BiometricPrompt` requires one. `FragmentActivity` extends
`ComponentActivity`, so `setContent`, `viewModels` and `enableEdgeToEdge`
all keep working unchanged.

**If you remove the biometric dependency, remove this pin too.** It exists
only to resolve that conflict.

---

## StrongBox is attempted at API 31, not 28

**`app/src/main/java/com/traderescue/app/data/DeviceKeys.kt`**

StrongBox has existed since API 28, and `KeyGenParameterSpec.Builder` has
had `setIsStrongBoxBacked` since then. But this app **imports** its keys
rather than generating them, and an imported key goes through
`KeyProtection.Builder`, which only gained `setIsStrongBoxBacked` in API 31
(S). Lint caught this; on a device it would have thrown.

The whole attempt — not just the flag — sits behind the version check,
because `StrongBoxUnavailableException` is itself API 28+ and cannot be
referenced in a `catch` below that.

A failure to use StrongBox is expected on plenty of hardware (support for
HMAC keys in the secure element is patchy) and is not an error: the key
still lands in the Keystore, just not in the secure element.

---

## The keys are imported, not generated

Generating a key inside the Keystore is the usual advice, and it is not
available here. The signature is an **HMAC**, so the server must hold the
same key to verify it. A Keystore-generated key can never leave the device,
so it could never be verified anywhere.

The consequence is stated plainly in the README: the server holds every
device's key and could forge that device's packets. The Keystore protects
*use* of the key on the phone, not its secrecy from the backend.

The clean fix is asymmetric signatures, where the server holds only a
public key. It does not fit: an ECDSA P-256 signature is 128 hex
characters, pushing the packet to roughly 204 and breaking the one-segment
guarantee the whole format exists to respect. Recorded as future work.

---

## The response sub-key needs no user authentication

The request sub-key requires biometric or device-credential authentication
on **every** use, because signing an order moves money.

The response sub-key, which only verifies the server's confirmations,
requires none. This is deliberate: a confirmation arrives by SMS whenever
the network delivers it, there is no user present to prompt, and reading
one authorises nothing — it reports a decision the server already made.
Requiring authentication there would mean confirmations silently failing to
verify whenever the phone was in a pocket.

---

## Confirmations carry epoch seconds, not a readable date

The signed payload has to be byte-stable. A localised date ("17 Nov 2026,
10:45 pm IST") varies with the server's locale and can carry characters
that push the message out of GSM-7 and into two segments — which would
break the one-segment guarantee for the reply as well as make the signature
depend on formatting.

The app renders a friendly time from the epoch seconds. A user reading the
raw SMS sees a number instead of a date; that is the cost of a reply that
cannot be forged.

---

## The decision time is stored, not stamped at send

A confirmation quotes the time the order was **decided**, taken from the
ledger, not the clock at the moment the reply is sent.

Without this, resending a packet produced a second validly signed message
attesting a new time for an old event, and two different signed
confirmations existed for one `tx_id`. Quoting the stored time makes a
replay byte-identical to the original reply, which is what "idempotent"
should mean to the person holding the phone.

---

## `MemoryStore` serialises its transactions

**`firebase/functions/store.js`**

The in-memory store queues transactions through a single promise chain, and
the body of each is synchronous. This is not an optimisation; it is the
whole reason the adapter is trustworthy. Firestore gives a transaction
atomic read-modify-write, and a fake without that property would let a
duplicate packet race its own copy and "pass" tests that production would
fail.

The swallowed rejection on the queue (`run.catch(() => {})`) matters too:
without it, one caller's refusal would reject the next caller in line.
There is a test for exactly that.

---

## The failure lab does its own arithmetic

**`tools/failure-lab.js`**

The lab deliberately does **not** import `effectiveExpiry()` or
`hashPacket()` from the code it is checking, and keeps its own copies of
the timing constants with a startup assertion that they have not drifted.

A checker that borrows the arithmetic it is checking cannot see a bug in
it: both sides would make the same mistake and agree. The duplicated
constants are the point, not an oversight.
