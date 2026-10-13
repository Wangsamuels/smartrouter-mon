/**
 * Privy sign-in (email code or Google). The frontend sends Privy's identity token: an ES256
 * JWT signed by Privy (iss "privy.io", aud = our Privy app id) whose `linked_accounts` claim
 * lists the user's email / Google account and their embedded wallet. We verify it against
 * the app's public JWKS — no Privy secret needed on the server.
 *
 * Requires "Return user data in an identity token" in the Privy dashboard
 * (User management → Authentication → Advanced).
 */
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, type JWTVerifyOptions, type KeyLike } from 'jose'

export type PrivyIdentity = {
  did: string
  email?: string
  loginMethod: 'google' | 'email' | 'other'
  /** Privy embedded Ethereum wallet (works on Tempo), lowercase. */
  walletAddress?: string
}

type LinkedAccount = Record<string, unknown> & { type?: string }

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function parseLinkedAccounts(raw: unknown): LinkedAccount[] {
  if (Array.isArray(raw)) return raw as LinkedAccount[]
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  return []
}

/** Picks email, login method and the embedded wallet out of Privy's linked accounts. */
export function identityFromClaims(sub: string, linked: LinkedAccount[]): PrivyIdentity {
  const google = linked.find((a) => a.type === 'google_oauth')
  const emailAcct = linked.find((a) => a.type === 'email')
  const wallets = linked.filter((a) => a.type === 'wallet' && (str(a.chain_type) ?? str(a.chainType) ?? 'ethereum') === 'ethereum')
  const embedded = wallets.find((w) => (str(w.wallet_client_type) ?? str(w.walletClientType)) === 'privy') ?? wallets.find((w) => (str(w.connector_type) ?? str(w.connectorType)) === 'embedded')
  const email = str(emailAcct?.address) ?? str(google?.email)
  const address = str(embedded?.address)
  return {
    did: sub,
    email: email?.toLowerCase(),
    loginMethod: google ? 'google' : emailAcct ? 'email' : 'other',
    walletAddress: address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined,
  }
}

export function createPrivyVerifier(appId: string, keys?: JWTVerifyGetKey) {
  const jwks = keys ?? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`), { cooldownDuration: 60_000 })
  const opts: JWTVerifyOptions = { issuer: 'privy.io', audience: appId, algorithms: ['ES256'] }
  // Privy publishes several keys; a token without a `kid` matches all of them, so try each.
  async function verifyJwt(token: string) {
    try {
      return await jwtVerify(token, jwks, opts)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') throw err
      for await (const key of err as AsyncIterable<KeyLike>) {
        try {
          return await jwtVerify(token, key, opts)
        } catch (e) {
          if ((e as { code?: string }).code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') continue
          throw e
        }
      }
      throw new errors.JWSSignatureVerificationFailed()
    }
  }
  return async function verifyIdentityToken(token: string): Promise<PrivyIdentity> {
    const { payload } = await verifyJwt(token)
    if (!payload.sub?.startsWith('did:privy:')) throw new Error('not a Privy user token')
    return identityFromClaims(payload.sub, parseLinkedAccounts(payload.linked_accounts))
  }
}
