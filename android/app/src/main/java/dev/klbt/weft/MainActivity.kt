package dev.klbt.weft

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * The person browses in the system WebView even when libweft is missing.
 * Agent actions go through the same session_command as the desktop daemon.
 * Approval is an in-process dialog, not the desktop control file.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var session: PageSession

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val address = EditText(this).apply { hint = getString(R.string.address_hint) }
        val go = Button(this).apply { text = "→" }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(address, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(go)
        }
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                address.setText(url ?: "")
                session.inject()
            }
        }
        web.setOnTouchListener { _, _ ->
            session.noteGesture()
            false
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(row)
            addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
        val pack = assets.open("weft.pack").use { String(it.readBytes(), StandardCharsets.UTF_8) }
        val agent = assets.open("page_agent.js").use { String(it.readBytes(), StandardCharsets.UTF_8) }
        session = PageSession(this, web, pack, agent)
        if (!NativePolicy.available) Toast.makeText(this, R.string.policy_missing, Toast.LENGTH_LONG).show()
        go.setOnClickListener {
            val url = address.text.toString().trim()
            if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("about:")) web.loadUrl(url)
        }
        web.loadUrl("about:blank")
    }

    override fun onDestroy() {
        session.close()
        super.onDestroy()
    }
}

class PageSession(
    private val activity: Activity,
    private val web: WebView,
    private val pack: String,
    private val agent: String,
) {
    private var handle: Long = if (NativePolicy.available) NativePolicy.open(pack) else 0
    private var lastGesture = 0L
    private val preemptMs: Long = runCatching {
        JSONObject(pack).getJSONObject("defaults").optLong("preempt_ms", 400)
    }.getOrDefault(400)

    fun noteGesture() {
        lastGesture = System.currentTimeMillis()
    }

    fun inject() {
        val config = runCatching { JSONObject(pack).optJSONObject("defaults")?.optJSONObject("page") }.getOrNull()
        val prelude = "globalThis.__weftConfig = " + (config?.toString() ?: "{}") + ";\n" + agent + "\n"
        web.evaluateJavascript(prelude, null)
    }

    fun close() {
        if (handle != 0L) NativePolicy.close(handle)
        handle = 0
    }

    /** Used by a future on-device agent. The model never receives the dialog text. */
    fun act(action: JSONObject) {
        if (handle == 0L) return
        inject()
        web.evaluateJavascript("__weft.snapshot()") { raw ->
            val snapshot = runCatching { JSONObject(raw ?: "{}") }.getOrDefault(JSONObject())
            val request = JSONObject()
                .put("actor", "agent")
                .put("human_active", System.currentTimeMillis() - lastGesture < preemptMs)
                .put("snapshot", snapshot)
                .put("action", action)
            val command = JSONObject().put("cmd", "submit").put("request", request)
            val outcome = JSONObject(NativePolicy.command(handle, command.toString()))
            if (!outcome.optBoolean("ok")) return@evaluateJavascript
            val result = outcome.getJSONObject("result")
            val decision = result.getJSONObject("decision")
            when (decision.optString("effect")) {
                "allow" -> runAct(action)
                "approve" -> ask(result.getString("approval_id"), action, decision.optBoolean("fill_secret"))
                else -> Unit
            }
        }
    }

    private fun ask(id: String, action: JSONObject, secret: Boolean) {
        val field = if (secret) {
            EditText(activity).apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                hint = activity.getString(R.string.approve_secret_hint)
            }
        } else null
        AlertDialog.Builder(activity)
            .setTitle(R.string.approve_title)
            .setMessage(action.optString("op"))
            .setView(field)
            .setPositiveButton(R.string.allow) { _, _ ->
                val resolve = JSONObject().put("cmd", "resolve").put("actor", "person").put("id", id).put("decision", "allow")
                NativePolicy.command(handle, resolve.toString())
                if (secret) fillTrusted(action.optString("ref"), field?.text?.toString() ?: "")
                else runAct(action)
            }
            .setNegativeButton(R.string.deny) { _, _ ->
                val resolve = JSONObject().put("cmd", "resolve").put("actor", "person").put("id", id).put("decision", "deny")
                NativePolicy.command(handle, resolve.toString())
            }
            .show()
    }

    private fun runAct(action: JSONObject) {
        web.evaluateJavascript("__weft.act(" + action.toString() + ")", null)
    }

    private fun fillTrusted(ref: String, text: String) {
        web.evaluateJavascript(
            "__weft.fillTrusted(" + JSONObject.quote(ref) + "," + JSONObject.quote(text) + ")",
            null,
        )
    }
}
