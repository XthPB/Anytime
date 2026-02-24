import { Pool } from "pg";
import { env } from "../config.js";
import { generateCallId, generateChallenge, generateDeviceId, generateGroupId, generateMessageId, generateUserId } from "./ids.js";

export type User = {
  userId: string;
  createdAt: string;
};

export type Device = {
  deviceId: string;
  userId: string;
  deviceName: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  createdAt: string;
};

export type ChallengeRecord = {
  challenge: string;
  expiresAt: number;
};

export type UserPublicProfile = {
  userId: string;
  createdAt: string;
  encryptionPublicKey: string;
};

export type ContactRecord = {
  contactUserId: string;
  nickname: string | null;
  createdAt: string;
  encryptionPublicKey: string;
};

export type PreKeyBundle = {
  signedPreKey: string;
  signedPreKeySignature: string;
  oneTimePreKeys: string[];
};

export type GroupMemberRecord = {
  userId: string;
  encryptionPublicKey: string;
};

export type GroupRecord = {
  groupId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  members: GroupMemberRecord[];
};

export type EncryptedMessage = {
  messageId: string;
  clientMessageId?: string | null;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderPublicEncryptionKey: string;
  recipientUserId: string;
  ciphertext: string;
  nonce: string;
  editedAt: string | null;
  deletedAt: string | null;
  readAt: string | null;
  sentAt: string;
};

export type CallSessionRecord = {
  callId: string;
  createdBy: string;
  participants: string[];
  mode: "audio" | "video";
  createdAt: string;
  endedAt: string | null;
};

export type TypingIndicatorRecord = {
  conversationId: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: string;
};

export type SignalEnvelope = {
  signalId: string;
  callId: string;
  fromUserId: string;
  toUserId: string;
  senderPublicEncryptionKey: string;
  encryptedPayload: string;
  createdAt: string;
};

export class PersistentStore {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: env.DATABASE_URL });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        device_name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        encryption_public_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

      CREATE TABLE IF NOT EXISTS challenges (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        challenge TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS prekeys (
        user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        signed_prekey TEXT NOT NULL,
        signed_prekey_signature TEXT NOT NULL,
        one_time_prekeys JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS contacts (
        owner_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        contact_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        nickname TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner_user_id, contact_user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        client_message_id TEXT,
        conversation_id TEXT NOT NULL,
        sender_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        sender_device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
        sender_public_encryption_key TEXT NOT NULL,
        recipient_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        edited_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_messages_recipient_created ON messages(recipient_user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

      CREATE TABLE IF NOT EXISTS call_sessions (
        call_id TEXT PRIMARY KEY,
        created_by TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        participants JSONB NOT NULL,
        mode TEXT NOT NULL DEFAULT 'audio',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS call_signals (
        signal_id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES call_sessions(call_id) ON DELETE CASCADE,
        from_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        to_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        sender_public_encryption_key TEXT,
        encrypted_payload TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_call_signals_to_user_created ON call_signals(to_user_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_clears (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        cleared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS call_history_clears (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        peer_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        cleared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, peer_user_id)
      );

      CREATE TABLE IF NOT EXISTS message_hides (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS typing_indicators (
        conversation_id TEXT NOT NULL,
        from_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        to_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (conversation_id, from_user_id, to_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_typing_indicators_lookup
        ON typing_indicators(to_user_id, conversation_id, expires_at);
    `);

    await this.pool.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS client_message_id TEXT;

      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

      ALTER TABLE call_sessions
      ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'audio';

      ALTER TABLE call_signals
      ADD COLUMN IF NOT EXISTS sender_public_encryption_key TEXT;
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapMessageRow(row: any): EncryptedMessage {
    return {
      messageId: row.message_id,
      clientMessageId: row.client_message_id,
      conversationId: row.conversation_id,
      senderUserId: row.sender_user_id,
      senderDeviceId: row.sender_device_id,
      senderPublicEncryptionKey: row.sender_public_encryption_key,
      recipientUserId: row.recipient_user_id,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
      deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
      readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      sentAt: new Date(row.created_at).toISOString()
    };
  }

  async createUser(input: {
    deviceName: string;
    deviceSigningPublicKey: string;
    deviceEncryptionPublicKey: string;
  }): Promise<{ user: User; device: Device }> {
    const client = await this.pool.connect();
    const userId = generateUserId();
    const deviceId = generateDeviceId();

    try {
      await client.query("BEGIN");

      const userResult = await client.query(
        `INSERT INTO users (user_id) VALUES ($1) RETURNING user_id, created_at`,
        [userId]
      );

      const deviceResult = await client.query(
        `
          INSERT INTO devices (
            device_id,
            user_id,
            device_name,
            signing_public_key,
            encryption_public_key
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING device_id, user_id, device_name, signing_public_key, encryption_public_key, created_at
        `,
        [
          deviceId,
          userId,
          input.deviceName,
          input.deviceSigningPublicKey,
          input.deviceEncryptionPublicKey
        ]
      );

      await client.query("COMMIT");

      return {
        user: {
          userId: userResult.rows[0].user_id,
          createdAt: new Date(userResult.rows[0].created_at).toISOString()
        },
        device: {
          deviceId: deviceResult.rows[0].device_id,
          userId: deviceResult.rows[0].user_id,
          deviceName: deviceResult.rows[0].device_name,
          signingPublicKey: deviceResult.rows[0].signing_public_key,
          encryptionPublicKey: deviceResult.rows[0].encryption_public_key,
          createdAt: new Date(deviceResult.rows[0].created_at).toISOString()
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findUser(userId: string): Promise<User | null> {
    const result = await this.pool.query(
      `SELECT user_id, created_at FROM users WHERE user_id = $1`,
      [userId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return {
      userId: result.rows[0].user_id,
      createdAt: new Date(result.rows[0].created_at).toISOString()
    };
  }

  async findUserPublicProfile(userId: string): Promise<UserPublicProfile | null> {
    const result = await this.pool.query(
      `
        SELECT u.user_id, u.created_at, d.encryption_public_key
        FROM users u
        JOIN devices d ON d.user_id = u.user_id
        WHERE u.user_id = $1
          AND d.revoked_at IS NULL
        ORDER BY d.created_at ASC
        LIMIT 1
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return {
      userId: result.rows[0].user_id,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
      encryptionPublicKey: result.rows[0].encryption_public_key
    };
  }

  async findDevice(userId: string, deviceId: string): Promise<Device | null> {
    const result = await this.pool.query(
      `
        SELECT device_id, user_id, device_name, signing_public_key, encryption_public_key, created_at
        FROM devices
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL
      `,
      [userId, deviceId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return {
      deviceId: result.rows[0].device_id,
      userId: result.rows[0].user_id,
      deviceName: result.rows[0].device_name,
      signingPublicKey: result.rows[0].signing_public_key,
      encryptionPublicKey: result.rows[0].encryption_public_key,
      createdAt: new Date(result.rows[0].created_at).toISOString()
    };
  }

  async issueChallenge(userId: string, deviceId: string): Promise<string> {
    const challenge = generateChallenge();
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);

    await this.pool.query(
      `
        INSERT INTO challenges (user_id, device_id, challenge, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, device_id)
        DO UPDATE SET
          challenge = EXCLUDED.challenge,
          expires_at = EXCLUDED.expires_at,
          created_at = NOW()
      `,
      [userId, deviceId, challenge, expiresAt]
    );

    return challenge;
  }

  async consumeChallenge(userId: string, deviceId: string): Promise<ChallengeRecord | null> {
    const result = await this.pool.query(
      `
        DELETE FROM challenges
        WHERE user_id = $1 AND device_id = $2
        RETURNING challenge, expires_at
      `,
      [userId, deviceId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return {
      challenge: result.rows[0].challenge,
      expiresAt: Date.parse(new Date(result.rows[0].expires_at).toISOString())
    };
  }

  async setPreKeyBundle(userId: string, bundle: PreKeyBundle): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO prekeys (user_id, signed_prekey, signed_prekey_signature, one_time_prekeys)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          signed_prekey = EXCLUDED.signed_prekey,
          signed_prekey_signature = EXCLUDED.signed_prekey_signature,
          one_time_prekeys = EXCLUDED.one_time_prekeys,
          updated_at = NOW()
      `,
      [userId, bundle.signedPreKey, bundle.signedPreKeySignature, JSON.stringify(bundle.oneTimePreKeys)]
    );
  }

  async popPreKeyBundle(userId: string): Promise<Omit<PreKeyBundle, "oneTimePreKeys"> & { oneTimePreKey: string | null } | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
          SELECT signed_prekey, signed_prekey_signature, one_time_prekeys
          FROM prekeys
          WHERE user_id = $1
          FOR UPDATE
        `,
        [userId]
      );

      if (result.rowCount === 0) {
        await client.query("COMMIT");
        return null;
      }

      const oneTimePreKeys = Array.isArray(result.rows[0].one_time_prekeys)
        ? result.rows[0].one_time_prekeys.filter((k: unknown) => typeof k === "string")
        : [];

      const oneTimePreKey = oneTimePreKeys.shift() ?? null;

      await client.query(
        `UPDATE prekeys SET one_time_prekeys = $2::jsonb, updated_at = NOW() WHERE user_id = $1`,
        [userId, JSON.stringify(oneTimePreKeys)]
      );

      await client.query("COMMIT");

      return {
        signedPreKey: result.rows[0].signed_prekey,
        signedPreKeySignature: result.rows[0].signed_prekey_signature,
        oneTimePreKey
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async addContact(ownerUserId: string, contactUserId: string, nickname?: string): Promise<ContactRecord> {
    await this.pool.query(
      `
        INSERT INTO contacts (owner_user_id, contact_user_id, nickname)
        VALUES ($1, $2, $3)
        ON CONFLICT (owner_user_id, contact_user_id)
        DO UPDATE SET nickname = EXCLUDED.nickname
      `,
      [ownerUserId, contactUserId, nickname ?? null]
    );

    const result = await this.pool.query(
      `
        SELECT c.contact_user_id, c.nickname, c.created_at, d.encryption_public_key
        FROM contacts c
        JOIN devices d ON d.user_id = c.contact_user_id
        WHERE c.owner_user_id = $1
          AND c.contact_user_id = $2
          AND d.revoked_at IS NULL
        ORDER BY d.created_at ASC
        LIMIT 1
      `,
      [ownerUserId, contactUserId]
    );

    return {
      contactUserId: result.rows[0].contact_user_id,
      nickname: result.rows[0].nickname,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
      encryptionPublicKey: result.rows[0].encryption_public_key
    };
  }

  async listContacts(ownerUserId: string): Promise<ContactRecord[]> {
    const result = await this.pool.query(
      `
        SELECT DISTINCT ON (c.contact_user_id)
          c.contact_user_id,
          c.nickname,
          c.created_at,
          d.encryption_public_key
        FROM contacts c
        JOIN devices d ON d.user_id = c.contact_user_id
        WHERE c.owner_user_id = $1
          AND d.revoked_at IS NULL
        ORDER BY c.contact_user_id, d.created_at ASC
      `,
      [ownerUserId]
    );

    return result.rows.map((row) => ({
      contactUserId: row.contact_user_id,
      nickname: row.nickname,
      createdAt: new Date(row.created_at).toISOString(),
      encryptionPublicKey: row.encryption_public_key
    }));
  }

  async updateContactNickname(ownerUserId: string, contactUserId: string, nickname: string | null): Promise<ContactRecord | null> {
    const updated = await this.pool.query(
      `
        UPDATE contacts
        SET nickname = $3
        WHERE owner_user_id = $1 AND contact_user_id = $2
        RETURNING owner_user_id
      `,
      [ownerUserId, contactUserId, nickname]
    );

    if ((updated.rowCount ?? 0) === 0) {
      return null;
    }

    const records = await this.listContacts(ownerUserId);
    return records.find((record) => record.contactUserId === contactUserId) ?? null;
  }

  async deleteContact(ownerUserId: string, contactUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2`,
      [ownerUserId, contactUserId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async createGroup(input: { ownerUserId: string; name: string; memberUserIds: string[] }): Promise<GroupRecord> {
    const client = await this.pool.connect();
    const groupId = generateGroupId();
    const memberSet = Array.from(new Set([input.ownerUserId, ...input.memberUserIds]));

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO groups (group_id, owner_user_id, name) VALUES ($1, $2, $3)`,
        [groupId, input.ownerUserId, input.name]
      );

      for (const memberUserId of memberSet) {
        await client.query(
          `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`,
          [groupId, memberUserId]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return this.getGroupByIdForUser(groupId, input.ownerUserId);
  }

  async listGroupsForUser(userId: string): Promise<GroupRecord[]> {
    const groupsResult = await this.pool.query(
      `
        SELECT g.group_id, g.name, g.owner_user_id, g.created_at
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.group_id
        WHERE gm.user_id = $1
        ORDER BY g.created_at DESC
      `,
      [userId]
    );

    const groups: GroupRecord[] = [];
    for (const row of groupsResult.rows) {
      groups.push(await this.getGroupByIdForUser(row.group_id, userId));
    }

    return groups;
  }

  async getGroupByIdForUser(groupId: string, userId: string): Promise<GroupRecord> {
    const groupResult = await this.pool.query(
      `
        SELECT g.group_id, g.name, g.owner_user_id, g.created_at
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.group_id
        WHERE g.group_id = $1 AND gm.user_id = $2
        LIMIT 1
      `,
      [groupId, userId]
    );

    if (groupResult.rowCount === 0) {
      throw new Error("Group not found");
    }

    const membersResult = await this.pool.query(
      `
        SELECT gm.user_id, d.encryption_public_key
        FROM group_members gm
        JOIN LATERAL (
          SELECT encryption_public_key
          FROM devices
          WHERE user_id = gm.user_id AND revoked_at IS NULL
          ORDER BY created_at ASC
          LIMIT 1
        ) d ON true
        WHERE gm.group_id = $1
        ORDER BY gm.joined_at ASC
      `,
      [groupId]
    );

    return {
      groupId: groupResult.rows[0].group_id,
      name: groupResult.rows[0].name,
      ownerUserId: groupResult.rows[0].owner_user_id,
      createdAt: new Date(groupResult.rows[0].created_at).toISOString(),
      members: membersResult.rows.map((member) => ({
        userId: member.user_id,
        encryptionPublicKey: member.encryption_public_key
      }))
    };
  }

  async saveMessage(input: {
    clientMessageId?: string | null;
    conversationId: string;
    senderUserId: string;
    senderDeviceId: string;
    recipientUserId: string;
    ciphertext: string;
    nonce: string;
  }): Promise<EncryptedMessage> {
    const senderDevice = await this.findDevice(input.senderUserId, input.senderDeviceId);
    if (!senderDevice) {
      throw new Error("Sender device not found");
    }

    const messageId = generateMessageId();
    const result = await this.pool.query(
      `
        INSERT INTO messages (
          message_id,
          client_message_id,
          conversation_id,
          sender_user_id,
          sender_device_id,
          sender_public_encryption_key,
          recipient_user_id,
          ciphertext,
          nonce
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING message_id, client_message_id, conversation_id, sender_user_id, sender_device_id, sender_public_encryption_key,
                  recipient_user_id, ciphertext, nonce, edited_at, deleted_at, read_at, created_at
      `,
      [
        messageId,
        input.clientMessageId ?? null,
        input.conversationId,
        input.senderUserId,
        input.senderDeviceId,
        senderDevice.encryptionPublicKey,
        input.recipientUserId,
        input.ciphertext,
        input.nonce
      ]
    );

    return this.mapMessageRow(result.rows[0]);
  }

  async saveMessageBatch(input: {
    senderUserId: string;
    senderDeviceId: string;
    conversationId: string;
    clientMessageId: string | null;
    items: Array<{
      recipientUserId: string;
      ciphertext: string;
      nonce: string;
    }>;
  }): Promise<EncryptedMessage[]> {
    const saved: EncryptedMessage[] = [];
    for (const item of input.items) {
      saved.push(await this.saveMessage({
        senderUserId: input.senderUserId,
        senderDeviceId: input.senderDeviceId,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        recipientUserId: item.recipientUserId,
        ciphertext: item.ciphertext,
        nonce: item.nonce
      }));
    }

    return saved;
  }

  async listMessagesForUser(userId: string, sinceIso?: string): Promise<EncryptedMessage[]> {
    const since = sinceIso ? Date.parse(sinceIso) : NaN;
    const hasSince = !Number.isNaN(since);

    const query = hasSince
      ? `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $1 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $1 AND cc.conversation_id = m.conversation_id
          WHERE (m.recipient_user_id = $1 OR m.sender_user_id = $1)
            AND mh.message_id IS NULL
            AND m.created_at > GREATEST(COALESCE(cc.cleared_at, '-infinity'::timestamptz), $2::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $3
        `
      : `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $1 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $1 AND cc.conversation_id = m.conversation_id
          WHERE (m.recipient_user_id = $1 OR m.sender_user_id = $1)
            AND mh.message_id IS NULL
            AND m.created_at > COALESCE(cc.cleared_at, '-infinity'::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $2
        `;

    const params = hasSince
      ? [userId, new Date(since).toISOString(), env.MAX_INBOX_BATCH]
      : [userId, env.MAX_INBOX_BATCH];

    const result = await this.pool.query(query, params);

    return result.rows.map((row) => this.mapMessageRow(row));
  }

  async listConversation(userId: string, contactUserId: string, sinceIso?: string): Promise<EncryptedMessage[]> {
    const since = sinceIso ? Date.parse(sinceIso) : NaN;
    const conversationId = [userId, contactUserId].sort().join("__");
    const hasSince = !Number.isNaN(since);

    const query = hasSince
      ? `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $1 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $1 AND cc.conversation_id = $3
          WHERE (
            (m.sender_user_id = $1 AND m.recipient_user_id = $2) OR
            (m.sender_user_id = $2 AND m.recipient_user_id = $1)
          )
            AND mh.message_id IS NULL
            AND m.created_at > GREATEST(COALESCE(cc.cleared_at, '-infinity'::timestamptz), $4::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $5
        `
      : `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $1 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $1 AND cc.conversation_id = $3
          WHERE (
            (m.sender_user_id = $1 AND m.recipient_user_id = $2) OR
            (m.sender_user_id = $2 AND m.recipient_user_id = $1)
          )
            AND mh.message_id IS NULL
            AND m.created_at > COALESCE(cc.cleared_at, '-infinity'::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $4
        `;

    const params = hasSince
      ? [userId, contactUserId, conversationId, new Date(since).toISOString(), env.MAX_INBOX_BATCH]
      : [userId, contactUserId, conversationId, env.MAX_INBOX_BATCH];

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mapMessageRow(row));
  }

  async listConversationById(userId: string, conversationId: string, sinceIso?: string): Promise<EncryptedMessage[]> {
    const since = sinceIso ? Date.parse(sinceIso) : NaN;
    const hasSince = !Number.isNaN(since);

    const query = hasSince
      ? `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $2 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $2 AND cc.conversation_id = $1
          WHERE m.conversation_id = $1
            AND (m.sender_user_id = $2 OR m.recipient_user_id = $2)
            AND mh.message_id IS NULL
            AND m.created_at > GREATEST(COALESCE(cc.cleared_at, '-infinity'::timestamptz), $3::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $4
        `
      : `
          SELECT m.message_id, m.client_message_id, m.conversation_id, m.sender_user_id, m.sender_device_id, m.sender_public_encryption_key,
                 m.recipient_user_id, m.ciphertext, m.nonce, m.edited_at, m.deleted_at, m.read_at, m.created_at
          FROM messages m
          LEFT JOIN message_hides mh ON mh.user_id = $2 AND mh.message_id = m.message_id
          LEFT JOIN conversation_clears cc ON cc.user_id = $2 AND cc.conversation_id = $1
          WHERE m.conversation_id = $1
            AND (m.sender_user_id = $2 OR m.recipient_user_id = $2)
            AND mh.message_id IS NULL
            AND m.created_at > COALESCE(cc.cleared_at, '-infinity'::timestamptz)
          ORDER BY m.created_at ASC
          LIMIT $3
        `;

    const params = hasSince
      ? [conversationId, userId, new Date(since).toISOString(), env.MAX_INBOX_BATCH]
      : [conversationId, userId, env.MAX_INBOX_BATCH];

    const result = await this.pool.query(query, params);
    return result.rows.map((row) => this.mapMessageRow(row));
  }

  async editMessageById(input: {
    messageId: string;
    senderUserId: string;
    ciphertext: string;
    nonce: string;
  }): Promise<EncryptedMessage | null> {
    const result = await this.pool.query(
      `
        UPDATE messages
        SET ciphertext = $3, nonce = $4, edited_at = NOW(), deleted_at = NULL
        WHERE message_id = $1 AND sender_user_id = $2
        RETURNING message_id, client_message_id, conversation_id, sender_user_id, sender_device_id, sender_public_encryption_key,
                  recipient_user_id, ciphertext, nonce, edited_at, deleted_at, read_at, created_at
      `,
      [input.messageId, input.senderUserId, input.ciphertext, input.nonce]
    );

    if ((result.rowCount ?? 0) === 0) return null;
    return this.mapMessageRow(result.rows[0]);
  }

  async editMessageByClientMessageId(input: {
    conversationId: string;
    clientMessageId: string;
    senderUserId: string;
    items: Array<{
      recipientUserId: string;
      ciphertext: string;
      nonce: string;
    }>;
  }): Promise<EncryptedMessage[]> {
    const updated: EncryptedMessage[] = [];

    for (const item of input.items) {
      const result = await this.pool.query(
        `
          UPDATE messages
          SET ciphertext = $5, nonce = $6, edited_at = NOW(), deleted_at = NULL
          WHERE conversation_id = $1
            AND client_message_id = $2
            AND sender_user_id = $3
            AND recipient_user_id = $4
          RETURNING message_id, client_message_id, conversation_id, sender_user_id, sender_device_id, sender_public_encryption_key,
                    recipient_user_id, ciphertext, nonce, edited_at, deleted_at, read_at, created_at
        `,
        [
          input.conversationId,
          input.clientMessageId,
          input.senderUserId,
          item.recipientUserId,
          item.ciphertext,
          item.nonce
        ]
      );

      if ((result.rowCount ?? 0) > 0) {
        updated.push(this.mapMessageRow(result.rows[0]));
      }
    }

    return updated;
  }

  async deleteMessageById(messageId: string, senderUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE messages
        SET deleted_at = NOW()
        WHERE message_id = $1 AND sender_user_id = $2
      `,
      [messageId, senderUserId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMessageByClientMessageId(conversationId: string, clientMessageId: string, senderUserId: string): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE messages
        SET deleted_at = NOW()
        WHERE conversation_id = $1
          AND client_message_id = $2
          AND sender_user_id = $3
      `,
      [conversationId, clientMessageId, senderUserId]
    );
    return result.rowCount ?? 0;
  }

  async hideMessageForUser(userId: string, messageId: string): Promise<boolean> {
    const exists = await this.pool.query(
      `
        SELECT 1
        FROM messages
        WHERE message_id = $1
          AND (sender_user_id = $2 OR recipient_user_id = $2)
        LIMIT 1
      `,
      [messageId, userId]
    );

    if ((exists.rowCount ?? 0) === 0) {
      return false;
    }

    await this.pool.query(
      `
        INSERT INTO message_hides (user_id, message_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, message_id) DO NOTHING
      `,
      [userId, messageId]
    );

    return true;
  }

  async clearConversationForUser(userId: string, conversationId: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_clears (user_id, conversation_id, cleared_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id, conversation_id)
        DO UPDATE SET cleared_at = EXCLUDED.cleared_at
      `,
      [userId, conversationId]
    );
  }

  async clearCallHistoryForPeer(userId: string, peerUserId: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO call_history_clears (user_id, peer_user_id, cleared_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id, peer_user_id)
        DO UPDATE SET cleared_at = EXCLUDED.cleared_at
      `,
      [userId, peerUserId]
    );
  }

  async markConversationRead(userId: string, conversationId: string): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE messages
        SET read_at = NOW()
        WHERE conversation_id = $1
          AND recipient_user_id = $2
          AND read_at IS NULL
          AND deleted_at IS NULL
      `,
      [conversationId, userId]
    );

    return result.rowCount ?? 0;
  }

  async setTypingIndicator(input: {
    conversationId: string;
    fromUserId: string;
    toUserId: string;
    ttlSeconds: number;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO typing_indicators (conversation_id, from_user_id, to_user_id, expires_at, updated_at)
        VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval, NOW())
        ON CONFLICT (conversation_id, from_user_id, to_user_id)
        DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `,
      [input.conversationId, input.fromUserId, input.toUserId, input.ttlSeconds]
    );
  }

  async listTypingIndicators(userId: string, conversationId: string): Promise<TypingIndicatorRecord[]> {
    await this.pool.query(`DELETE FROM typing_indicators WHERE expires_at <= NOW()`);
    const result = await this.pool.query(
      `
        SELECT conversation_id, from_user_id, to_user_id, expires_at
        FROM typing_indicators
        WHERE to_user_id = $1
          AND conversation_id = $2
          AND expires_at > NOW()
        ORDER BY updated_at DESC
      `,
      [userId, conversationId]
    );

    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      expiresAt: new Date(row.expires_at).toISOString()
    }));
  }

  async createCall(participants: string[], createdBy: string, mode: "audio" | "video"): Promise<{ callId: string; participants: string[]; mode: "audio" | "video"; createdAt: string }> {
    const callId = generateCallId();
    const result = await this.pool.query(
      `
        INSERT INTO call_sessions (call_id, created_by, participants, mode)
        VALUES ($1, $2, $3::jsonb, $4)
        RETURNING call_id, participants, mode, created_at
      `,
      [callId, createdBy, JSON.stringify(participants), mode]
    );

    return {
      callId: result.rows[0].call_id,
      participants: result.rows[0].participants,
      mode: result.rows[0].mode,
      createdAt: new Date(result.rows[0].created_at).toISOString()
    };
  }

  async endCall(callId: string, byUserId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE call_sessions
        SET ended_at = COALESCE(ended_at, NOW())
        WHERE call_id = $1
          AND participants ? $2
      `,
      [callId, byUserId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listCallHistoryForPeer(userId: string, peerUserId: string, limit = 100): Promise<CallSessionRecord[]> {
    const result = await this.pool.query(
      `
        SELECT c.call_id, c.created_by, c.participants, c.mode, c.created_at, c.ended_at
        FROM call_sessions c
        LEFT JOIN call_history_clears chc
          ON chc.user_id = $1 AND chc.peer_user_id = $2
        WHERE c.participants ? $1
          AND c.participants ? $2
          AND c.created_at > COALESCE(chc.cleared_at, '-infinity'::timestamptz)
        ORDER BY c.created_at DESC
        LIMIT $3
      `,
      [userId, peerUserId, limit]
    );

    return result.rows.map((row) => ({
      callId: row.call_id,
      createdBy: row.created_by,
      participants: Array.isArray(row.participants) ? row.participants : [],
      mode: row.mode === "video" ? "video" : "audio",
      createdAt: new Date(row.created_at).toISOString(),
      endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null
    }));
  }

  async enqueueSignal(input: Omit<SignalEnvelope, "signalId" | "createdAt">): Promise<SignalEnvelope> {
    const signalId = generateMessageId();
    const result = await this.pool.query(
      `
        INSERT INTO call_signals (
          signal_id,
          call_id,
          from_user_id,
          to_user_id,
          sender_public_encryption_key,
          encrypted_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING signal_id, call_id, from_user_id, to_user_id, sender_public_encryption_key, encrypted_payload, created_at
      `,
      [
        signalId,
        input.callId,
        input.fromUserId,
        input.toUserId,
        input.senderPublicEncryptionKey,
        input.encryptedPayload
      ]
    );

    return {
      signalId: result.rows[0].signal_id,
      callId: result.rows[0].call_id,
      fromUserId: result.rows[0].from_user_id,
      toUserId: result.rows[0].to_user_id,
      senderPublicEncryptionKey: result.rows[0].sender_public_encryption_key,
      encryptedPayload: result.rows[0].encrypted_payload,
      createdAt: new Date(result.rows[0].created_at).toISOString()
    };
  }

  async dequeueSignals(userId: string): Promise<SignalEnvelope[]> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const selected = await client.query(
        `
          SELECT signal_id, call_id, from_user_id, to_user_id, sender_public_encryption_key, encrypted_payload, created_at
          FROM call_signals
          WHERE to_user_id = $1
          ORDER BY created_at ASC
          LIMIT $2
        `,
        [userId, env.MAX_INBOX_BATCH]
      );

      const ids = selected.rows.map((row) => row.signal_id);
      if (ids.length > 0) {
        await client.query(
          `DELETE FROM call_signals WHERE signal_id = ANY($1::text[])`,
          [ids]
        );
      }

      await client.query("COMMIT");

      return selected.rows.map((row) => ({
        signalId: row.signal_id,
        callId: row.call_id,
        fromUserId: row.from_user_id,
        toUserId: row.to_user_id,
        senderPublicEncryptionKey: row.sender_public_encryption_key,
        encryptedPayload: row.encrypted_payload,
        createdAt: new Date(row.created_at).toISOString()
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const store = new PersistentStore();
