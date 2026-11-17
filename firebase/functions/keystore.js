"use strict";

const { newDeviceSecret, newKeyId } = require("./keys");

/**
 * Where device secrets live.
 *
 * Same shape as store.js: one interface, a memory adapter that the tests
 * and the failure lab drive, and a Secret Manager adapter for a real
 * deployment. As with FirestoreStore, the Secret Manager adapter here is a
 * transposition that has NOT been run against the real service -- the
 * guarantees in the tests are proven on MemoryKeyStore only. The README
 * says so too.
 *
 * A device record:
 *
 *   keyId       8 hex characters, carried in the packet
 *   userId      whose portfolio this device may sell from
 *   secret      the 32-byte device secret, from which both sub-keys derive
 *   status      "active" | "revoked" | "rotated"
 *   rotatedAt   when a rotated key stopped being the current one
 *   replacedBy  the keyId that replaced it
 *   createdAt
 *
 * Rotation does not kill the old key immediately. A packet already in
 * flight was signed with it in good faith, and SMS is store-and-forward, so
 * the old key stays usable for one maximum packet lifetime and then stops.
 * service.js owns that arithmetic; this file only records when it happened.
 */

class MemoryKeyStore {
  constructor() {
    this.devices = new Map();
  }

  async get(keyId) {
    const found = this.devices.get(keyId);
    return found ? { ...found, secret: Buffer.from(found.secret) } : null;
  }

  async put(record) {
    this.devices.set(record.keyId, { ...record, secret: Buffer.from(record.secret) });
    return this.get(record.keyId);
  }

  async setStatus(keyId, patch) {
    const found = this.devices.get(keyId);
    if (!found) return null;
    this.devices.set(keyId, { ...found, ...patch });
    return this.get(keyId);
  }

  async listForUser(userId) {
    return [...this.devices.values()]
      .filter((d) => d.userId === userId)
      .map((d) => ({ ...d, secret: undefined }));
  }
}

/**
 * Google Secret Manager, one secret version per device.
 *
 * UNTESTED. It is written to the same interface and mirrors the memory
 * adapter's behaviour, but nothing in this repo has run it against the real
 * API: no test covers it and the failure lab does not touch it. Treat it
 * the way the README treats FirestoreStore -- plausible, not demonstrated.
 *
 * The client is injected rather than imported so this module pulls in no
 * Google libraries of its own and the file stays requirable from a test.
 */
class SecretManagerKeyStore {
  constructor(client, projectId) {
    this.client = client;
    this.projectId = projectId;
  }

  secretName(keyId) {
    return `projects/${this.projectId}/secrets/traderescue-device-${keyId}`;
  }

  async get(keyId) {
    try {
      const [version] = await this.client.accessSecretVersion({ name: `${this.secretName(keyId)}/versions/latest` });
      const [secretMeta] = await this.client.getSecret({ name: this.secretName(keyId) });
      const labels = secretMeta.labels || {};
      return {
        keyId,
        userId: labels.user_id,
        secret: Buffer.from(version.payload.data.toString(), "hex"),
        status: labels.status || "active",
        rotatedAt: labels.rotated_at ? Number(labels.rotated_at) : null,
        replacedBy: labels.replaced_by || null,
        createdAt: labels.created_at ? Number(labels.created_at) : null,
      };
    } catch (e) {
      if (e && (e.code === 5 || e.code === 404)) return null; // NOT_FOUND
      throw e;
    }
  }

  async put(record) {
    const labels = {
      user_id: record.userId,
      status: record.status,
      created_at: String(record.createdAt || 0),
    };
    await this.client.createSecret({
      parent: `projects/${this.projectId}`,
      secretId: `traderescue-device-${record.keyId}`,
      secret: { replication: { automatic: {} }, labels },
    });
    await this.client.addSecretVersion({
      parent: this.secretName(record.keyId),
      payload: { data: Buffer.from(record.secret.toString("hex"), "utf8") },
    });
    return this.get(record.keyId);
  }

  async setStatus(keyId, patch) {
    const current = await this.get(keyId);
    if (!current) return null;
    const labels = {
      user_id: current.userId,
      status: patch.status || current.status,
      created_at: String(current.createdAt || 0),
    };
    if (patch.rotatedAt || current.rotatedAt) labels.rotated_at = String(patch.rotatedAt || current.rotatedAt);
    if (patch.replacedBy || current.replacedBy) labels.replaced_by = patch.replacedBy || current.replacedBy;
    await this.client.updateSecret({
      secret: { name: this.secretName(keyId), labels },
      updateMask: { paths: ["labels"] },
    });
    return this.get(keyId);
  }

  async listForUser() {
    // Listing by label needs a filtered list call; not implemented because
    // nothing here uses it and an untested guess is worse than an honest gap.
    throw new Error("listForUser is not implemented for SecretManagerKeyStore");
  }
}

/** A fresh device record, ready to be stored. */
function newDevice(userId, createdAt) {
  return {
    keyId: newKeyId(),
    userId,
    secret: newDeviceSecret(),
    status: "active",
    rotatedAt: null,
    replacedBy: null,
    createdAt,
  };
}

module.exports = { MemoryKeyStore, SecretManagerKeyStore, newDevice };
