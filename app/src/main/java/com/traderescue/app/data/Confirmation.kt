package com.traderescue.app.data

/**
 * The server's signed reply to an emergency order.
 *
 *   TradeRescue: SOLD 5 RELIANCE @Rs1485.20 (15 left) Ref TRX0A1B2C 1700000060 #<16 hex>
 *   TradeRescue: NOT SOLD (EXPIRED) Ref TRX0A1B2C 1700000060 #<16 hex>
 *
 * The tag is HMAC-SHA256 over everything before " #", truncated to 16 hex
 * characters, using this device's response sub-key. Sixty-four bits is
 * plenty for a message that authorises nothing -- it reports a decision the
 * server already made, it does not cause one.
 *
 * The timestamp is epoch seconds rather than a formatted date because the
 * signed payload has to be byte-stable: a localised date varies with the
 * server's locale and can carry characters that push the message out of
 * GSM-7 and into two segments. The app formats it for the screen.
 *
 * Mirrors confirmationText/verifyConfirmation in the backend's packet.js.
 */
data class Confirmation(
    val status: String,
    val txId: String,
    val at: Long,
    val quantity: Int? = null,
    val symbol: String? = null,
    val fillPrice: Double? = null,
    val remaining: Int? = null,
    val text: String,
) {
    val isFill: Boolean get() = status == "FILLED"

    companion object {
        const val TAG_HEX = 16

        private val FILLED = Regex(
            """^TradeRescue: SOLD (\d+) ([A-Za-z0-9&-]+) @Rs([\d.]+) \((\d+) left\) Ref ([A-Za-z0-9]+) (\d+)$""",
        )
        private val REFUSED = Regex(
            """^TradeRescue: NOT SOLD \(([A-Z_]+)\) Ref ([A-Za-z0-9]+) (\d+)$""",
        )

        /** Looks like one of ours, before anyone claims it is genuine. */
        fun looksLikeConfirmation(message: String): Boolean =
            message.trim().startsWith("TradeRescue:") && message.trim().contains(" #")

        /**
         * Returns the confirmation only if the tag checks out, and null
         * otherwise -- never a flag on a half-trusted object. A caller
         * cannot treat an unverified message as a fill by forgetting to
         * read a boolean, because there is no object to misread.
         */
        fun verify(message: String, sign: (String) -> String): Confirmation? {
            val text = message.trim()
            val split = text.lastIndexOf(" #")
            if (split < 0) return null
            val body = text.substring(0, split)
            val tag = text.substring(split + 2)
            if (tag.length != TAG_HEX) return null
            if (!constantTimeEquals(tag, sign(body).take(TAG_HEX))) return null
            return parse(body)
        }

        private fun parse(body: String): Confirmation? {
            FILLED.matchEntire(body)?.let { m ->
                return Confirmation(
                    status = "FILLED",
                    quantity = m.groupValues[1].toIntOrNull() ?: return null,
                    symbol = m.groupValues[2],
                    fillPrice = m.groupValues[3].toDoubleOrNull() ?: return null,
                    remaining = m.groupValues[4].toIntOrNull() ?: return null,
                    txId = m.groupValues[5],
                    at = m.groupValues[6].toLongOrNull() ?: return null,
                    text = body,
                )
            }
            REFUSED.matchEntire(body)?.let { m ->
                return Confirmation(
                    status = m.groupValues[1],
                    txId = m.groupValues[2],
                    at = m.groupValues[3].toLongOrNull() ?: return null,
                    text = body,
                )
            }
            return null
        }

        /** Comparison that does not leak where two tags start to differ. */
        private fun constantTimeEquals(a: String, b: String): Boolean {
            if (a.length != b.length) return false
            var diff = 0
            for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
            return diff == 0
        }
    }
}
