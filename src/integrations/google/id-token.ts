import { OAuth2Client } from 'google-auth-library'
import { AppError } from '../../http/errors.js'

/** What we keep from a checked Google sign-in token. The subject is Google's permanent id for the person; the email can change. */
export type GoogleIdentity = { subject: string; email: string; emailVerified: boolean; name: string }
export type GoogleIdTokenVerifier = (idToken: string) => Promise<GoogleIdentity>

/**
 * Checks a Google ID token the phone obtained after "Continue with Google": the signature (against Google's published keys), the
 * expiry, the issuer, and that it was issued for OUR app (the web client id), so a token made for another app is never accepted.
 * Any failure is the same plain 401, and the reason stays out of the answer.
 */
export function createGoogleIdTokenVerifier(webClientId: string, client: Pick<OAuth2Client, 'verifyIdToken'> = new OAuth2Client()): GoogleIdTokenVerifier {
  return async idToken => {
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: webClientId })
      const payload = ticket.getPayload()
      if (!payload?.sub || !payload.email) throw new Error('Token has no subject or email.')
      return { subject: payload.sub, email: payload.email.trim().toLowerCase(), emailVerified: payload.email_verified === true, name: (payload.name ?? '').trim().slice(0, 100) }
    } catch {
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified. Please try again.')
    }
  }
}
