import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Operators may supply a vault-backed implementation; references never contain credentials. */
export interface SecretStore {
  seal(value: string, context: string): Promise<string>;
  open(reference: string, context: string): Promise<string>;
}

/** AES-GCM authenticates both ciphertext and its workspace/provider/locator binding. */
export function encryptedSecretStore(keys: Record<string, string>, activeKey: string): SecretStore {
  const material = (id: string) => {
    const encoded = keys[id];
    if (!encoded || !/^[0-9a-f]{64}$/i.test(encoded))
      throw new Error(
        'Integration encryption key unavailable. Restore the configured key version; do not replace or print the credential.',
      );
    return Buffer.from(encoded, 'hex');
  };
  material(activeKey);
  return {
    async seal(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', material(activeKey), iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `enc:v1:${activeKey}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
    },
    async open(reference, context) {
      const [prefix, version, id, iv, tag, data, extra] = reference.split(':');
      if (prefix !== 'enc' || version !== 'v1' || !id || !iv || !tag || !data || extra)
        throw new Error('Invalid encrypted credential envelope.');
      try {
        const cipher = createDecipheriv('aes-256-gcm', material(id), Buffer.from(iv, 'base64url'));
        cipher.setAAD(Buffer.from(context));
        cipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          cipher.update(Buffer.from(data, 'base64url')),
          cipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error(
          'Credential decryption failed. Check key version and binding; no provider request was made.',
        );
      }
    },
  };
}

const configured = (): SecretStore | undefined => {
  const encoded = process.env.STMA_INTEGRATION_KEYS;
  if (!encoded) return undefined;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(encoded);
  } catch {
    throw new Error('Invalid integration key configuration.');
  }
  const active = process.env.STMA_INTEGRATION_ACTIVE_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(active))
    throw new Error('Set STMA_INTEGRATION_ACTIVE_KEY to a configured key version.');
  return encryptedSecretStore(keys, active);
};
export async function protectIntegrationSecret(value: string, context: string) {
  const store = configured();
  if (!store && process.env.STMA_INTEGRATION_REQUIRE_ENCRYPTION === '1')
    throw new Error(
      'New integration credentials require an operator-configured encryption key store. No credential was stored.',
    );
  // Compatibility mode is explicit in the data inventory. Operators migrate in a
  // dry run first; adding a key protects all NEW writes without destroying legacy data.
  return store ? store.seal(value, context) : value;
}
export async function revealIntegrationSecret(value: string, context: string) {
  if (!value.startsWith('enc:')) return value;
  const store = configured();
  if (!store)
    throw new Error(
      'Integration encryption is configured in the data but its keys are unavailable.',
    );
  return store.open(value, context);
}

/**
 * Authenticator-app secrets, sealed with the same keyring as integration
 * credentials and separated from them by the associated data.
 *
 * The integration path above keeps a plaintext compatibility mode for
 * self-hosted instances that have no key yet. This one never does, whatever
 * `STMA_INTEGRATION_REQUIRE_ENCRYPTION` says: a seed readable from a database
 * dump would turn a database read into the second factor itself. With no key
 * configured, sealing throws and the account page offers no enrollment at all.
 *
 * The context binds an envelope to its account, so a sealed secret copied onto
 * another user's row does not open there.
 */
const authContext = (userId: string) => `authenticator:v1:${userId}`;

export const AUTH_SECRETS_UNAVAILABLE =
  'Authenticator apps need an encryption key on this server. Ask the operator to set STMA_INTEGRATION_KEYS.';

/** Whether this server can seal a new authenticator secret right now. Never throws. */
export function authSecretsAvailable(): boolean {
  try {
    return configured() !== undefined;
  } catch {
    return false;
  }
}

export async function sealAuthSecret(value: string, userId: string): Promise<string> {
  const store = configured();
  if (!store) throw new Error(AUTH_SECRETS_UNAVAILABLE);
  return store.seal(value, authContext(userId));
}

/** Throws when the key is missing or the envelope does not belong to this account. */
export async function openAuthSecret(reference: string, userId: string): Promise<string> {
  if (!reference.startsWith('enc:')) throw new Error('Authenticator secret is not sealed.');
  const store = configured();
  if (!store) throw new Error(AUTH_SECRETS_UNAVAILABLE);
  return store.open(reference, authContext(userId));
}

/**
 * Re-seal one authenticator secret under the active key version, checked by
 * opening the result before it is returned. Key rotation
 * (`scripts/rotate-integration-secrets.ts`) moves every row through this, so
 * the rule a rotation depends on is the one the suite exercises.
 */
export async function resealAuthSecret(reference: string, userId: string): Promise<string> {
  const plain = await openAuthSecret(reference, userId);
  const sealed = await sealAuthSecret(plain, userId);
  if ((await openAuthSecret(sealed, userId)) !== plain) throw new Error('Encryption roundtrip failed.');
  return sealed;
}

/** Strict integration sealing for features that cannot accept plaintext compatibility mode. */
export function integrationSecretKeyAvailable() {
  try {
    return configured() !== undefined;
  } catch {
    return false;
  }
}

export async function sealIntegrationSecret(value: string, context: string) {
  const store = configured();
  if (!store) throw new Error('An integration encryption key is required.');
  return store.seal(value, context);
}

export async function openSealedIntegrationSecret(reference: string, context: string) {
  if (!reference.startsWith('enc:')) throw new Error('Integration credential is not sealed.');
  const store = configured();
  if (!store) throw new Error('An integration encryption key is required.');
  return store.open(reference, context);
}
