/**
 * The signed envelope every document this extension ACTS ON arrives in, and
 * the hash that names a content-addressed object.
 *
 * These lived in service-worker.js. They moved here, unchanged, because the
 * chunked-list walk (list-sync.js) has to verify a root and name objects, and
 * it cannot import them from the worker: the worker imports the walk, and a
 * module that imports its importer is a circle. The worker imports them back
 * under the same local names, so its call sites read exactly as they did.
 */

/**
 * Check a signed envelope against the key compiled into this build.
 *
 * Used for both documents the extension ACTS on without a person in the loop:
 * the pointer that says where reports go, and the blocklist that says whom to
 * block. Returns the payload on success and null on anything else -- and
 * "anything else" includes a build with no key, because a build that cannot
 * verify must not accept, not accept anyway.
 */
export async function verifyEnvelope(doc) {
  const key = globalThis.CB_POINTER_KEY;
  if (!key) return null;
  if (!doc || typeof doc !== 'object' || !doc.payload || !doc.sig || doc.alg !== 'ed25519') {
    return null;
  }
  const b64url = (v) => Uint8Array.from(
    atob(String(v).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const body = new TextEncoder().encode(JSON.stringify(doc.payload));
  try {
    const pub = await crypto.subtle.importKey('raw', b64url(key),
      { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64url(doc.sig), body);
    return ok ? doc.payload : null;
  } catch (e) { return null; }
}

/** Does this look like a signed envelope, whatever it claims to hold? */
export function isEnvelope(doc) {
  return !!(doc && typeof doc === 'object' && doc.payload && doc.sig && doc.alg);
}

export const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * The name of a content-addressed object: SHA-256 of its exact bytes, as the
 * 64 lowercase hex characters the signed root spells it with. Computed on the
 * bytes as they arrived, BEFORE they are parsed or inflated, so nothing that
 * has not verified against the root is ever interpreted.
 */
export async function sha256Hex(buf) {
  return hex(await crypto.subtle.digest('SHA-256', buf));
}
