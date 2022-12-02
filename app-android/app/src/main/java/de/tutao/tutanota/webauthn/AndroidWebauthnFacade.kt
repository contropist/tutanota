package de.tutao.tutanota.webauthn

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsSessionToken
import de.tutao.tutanota.CancelledError
import de.tutao.tutanota.MainActivity
import de.tutao.tutanota.ipc.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

class AndroidWebauthnFacade(
	private val activity: MainActivity,
	private val json: Json
) : WebAuthnFacade {
	companion object {
		private const val TAG = "Webauthn"
	}

	override suspend fun register(challenge: WebAuthnRegistrationChallenge): WebAuthnRegistrationResult {
		TODO("Not yet implemented")
	}

	override suspend fun sign(challenge: WebAuthnSignChallenge): WebAuthnSignResult {
		// we should use the domain, right?
		// FIXME remove
		val serializedChallenge = json.encodeToString(challenge)
		Log.d(TAG, "Challenge: $serializedChallenge")
		val url = Uri.parse("http://local.tutanota.com:9000/client/build/webauthnmobile")
			.buildUpon()
			.appendQueryParameter(
				"cbUrl",
				"intent://webauthn/#Intent;scheme=tutanota;package=de.tutao.tutanota.debug;S.browser_fallback_url=http%3A%2F%2Fgoogle.com;S.result={result};end"
			)
			.appendQueryParameter("challenge", serializedChallenge)
			.build()
//		val url = Uri.parse("https://test.tutanota.com")
		val customIntent = CustomTabsIntent.Builder()
			.build()
		val sessionToken = CustomTabsSessionToken.getSessionTokenFromIntent(customIntent.intent)
		val intent = customIntent.intent.apply {
			data = url
			// close custom tabs activity as soon as user navigates away from it, otherwise it will linger as a separate
			// task
			addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY)
		}
		return suspendCoroutine { cont ->
			activity.webauthnResultHandler = {
				Log.d(TAG, "got result: $it")
				// FIXME
				cont.resumeWithException(CancelledError())
			}
			activity.startActivity(intent)
		}
	}

	override suspend fun abortCurrentOperation() {
		// FIXME
	}

	override suspend fun isSupported(): Boolean = true

	override suspend fun canAttemptChallengeForRpId(rpId: String): Boolean = true

	override suspend fun canAttemptChallengeForU2FAppId(appId: String): Boolean = true

}