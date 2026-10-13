import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose'
import { describe, expect, it } from 'vitest'
import { makeSessionToken } from '../src/middleware/auth.js'
import { createPrivyVerifier, identityFromClaims } from '../src/services/privy.js'

const APP = 'cmv3ikdu600ml0fl9xtzfhbvh'
const linked = [
  { type: 'google_oauth', email: 'Ada@Example.com', name: 'Ada', subject: '123' },
  { type: 'wallet', address: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01', chain_type: 'ethereum', wallet_client_type: 'privy', connector_type: 'embedded' },
  { type: 'wallet', address: '0x1111111111111111111111111111111111111111', chain_type: 'ethereum', wallet_client_type: 'metamask' },
]

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }
  const verify = createPrivyVerifier(APP, createLocalJWKSet({ keys: [jwk] }))
  const mint = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; sub?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(opts.iss ?? 'privy.io')
      .setAudience(opts.aud ?? APP)
      .setSubject(opts.sub ?? 'did:privy:abc123')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '1h')
      .sign(privateKey)
  return { verify, mint }
}

describe('Privy identity token', () => {
  it('extracts verified email, login method and the embedded wallet', async () => {
    const { verify, mint } = await setup()
    const id = await verify(await mint({ linked_accounts: JSON.stringify(linked) }))
    expect(id).toEqual({ did: 'did:privy:abc123', email: 'ada@example.com', loginMethod: 'google', walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01' })
  })
  it('email-code login', () => {
    const id = identityFromClaims('did:privy:x', [{ type: 'email', address: 'bob@ex.com' }, linked[1]!])
    expect(id.loginMethod).toBe('email')
    expect(id.email).toBe('bob@ex.com')
  })
  it('rejects a token for another app, another issuer, or expired', async () => {
    const { verify, mint } = await setup()
    await expect(verify(await mint({}, { aud: 'other-app' }))).rejects.toThrow()
    await expect(verify(await mint({}, { iss: 'evil.io' }))).rejects.toThrow()
    await expect(verify(await mint({}, { exp: '-1m' }))).rejects.toThrow()
    await expect(verify(await mint({}, { sub: 'user-1' }))).rejects.toThrow()
  })
})

describe('Privy token without kid', () => {
  it('is verified against each published key', async () => {
    const a = await generateKeyPair('ES256')
    const b = await generateKeyPair('ES256')
    const keys = [{ ...(await exportJWK(a.publicKey)), alg: 'ES256' }, { ...(await exportJWK(b.publicKey)), alg: 'ES256' }]
    const verify = createPrivyVerifier(APP, createLocalJWKSet({ keys }))
    const token = await new SignJWT({ linked_accounts: JSON.stringify(linked) }).setProtectedHeader({ alg: 'ES256' }).setIssuer('privy.io').setAudience(APP).setSubject('did:privy:k').setExpirationTime('1h').sign(b.privateKey)
    expect((await verify(token)).did).toBe('did:privy:k')
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setIssuer('privy.io').setAudience(APP).setSubject('did:privy:k').setExpirationTime('1h').sign((await generateKeyPair('ES256')).privateKey)
    await expect(verify(forged)).rejects.toThrow()
  })
})

describe('session token', () => {
  it('is <userId>.<exp>.<hmac> and changes with the secret', () => {
    const a = makeSessionToken('s'.repeat(32), '00000000-0000-0000-0000-000000000001', 123)
    const b = makeSessionToken('t'.repeat(32), '00000000-0000-0000-0000-000000000001', 123)
    expect(a.split('.')).toHaveLength(3)
    expect(a).not.toBe(b)
  })
})
