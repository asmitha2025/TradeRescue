package com.traderescue.app.data

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Thin wrapper over the two backend endpoints this app actually calls. */
class BackendApi(baseUrl: String) {
    private val base = baseUrl.trimEnd('/')

    /** The normal path — used when the app is actually online. */
    suspend fun placeNormalOrder(userId: String, symbol: String, action: String, qty: Int): Result<JSONObject> {
        val body = JSONObject().apply {
            put("user_id", userId)
            put("symbol", symbol)
            put("action", action)
            put("quantity", qty)
            put("order_type", "MARKET")
        }.toString().toRequestBody("application/json".toMediaType())
        return execute("$base/order") { post(body) }
    }

    /** The emergency path — posts an already-signed wire packet. Used as the
     * HTTP fallback when real SMS isn't available (no SEND_SMS permission,
     * running in an emulator, or testing without cellular). */
    suspend fun postEmergencyPacket(wirePacket: String): Result<JSONObject> {
        val body = wirePacket.toRequestBody("text/plain".toMediaType())
        return execute("$base/emergency/sms") { post(body) }
    }

    /** Gateway mode: hands an SMS this phone received to the backend. The
     * response's "reply" is the text to send back to the sender. */
    suspend fun forwardSms(from: String, text: String): Result<JSONObject> {
        val body = JSONObject().apply {
            put("from", from)
            put("text", text)
        }.toString().toRequestBody("application/json".toMediaType())
        return execute("$base/webhook/sms-forward") { post(body) }
    }

    /** The server's view of the portfolio — the source of truth once a
     * backend is configured, since that is where sells actually happen. */
    suspend fun getPortfolio(userId: String): Result<List<Holding>> =
        execute("$base/portfolio/$userId") { get() }.mapCatching { json ->
            val items = json.getJSONArray("holdings")
            List(items.length()) { i ->
                val h = items.getJSONObject(i)
                Holding(
                    symbol = h.getString("symbol"),
                    qty = h.getInt("qty"),
                    price = h.getDouble("price"),
                    changePct = h.optDouble("change_pct", 0.0),
                    emergencyLimit = h.getInt("emergency_limit"),
                )
            }
        }

    private suspend fun execute(url: String, configure: Request.Builder.() -> Request.Builder): Result<JSONObject> {
        // A mistyped URL in Settings throws here rather than in the callback.
        val request = try {
            Request.Builder().url(url).configure().build()
        } catch (e: IllegalArgumentException) {
            return Result.failure(Exception("Backend URL is not valid: $base"))
        }
        return suspendCancellableCoroutine { cont ->
            val call = client.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resume(Result.failure(e))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = try {
                        val text = response.use { it.body?.string().orEmpty() }
                        try {
                            val json = JSONObject(text)
                            if (response.isSuccessful) Result.success(json)
                            else Result.failure(Exception(json.optString("detail", "HTTP ${response.code}")))
                        } catch (e: Exception) {
                            Result.failure(Exception("Unexpected response (HTTP ${response.code}): ${text.take(120)}"))
                        }
                    } catch (e: IOException) {
                        Result.failure(e)
                    }
                    if (cont.isActive) cont.resume(result)
                }
            })
        }
    }

    private companion object {
        // One shared client (connection pool + threads) for the whole app.
        // The read timeout is generous because free-tier hosts cold-start.
        val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
