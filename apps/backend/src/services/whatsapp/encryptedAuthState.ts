import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { decryptSecret, encryptSecret } from '../../crypto/security.js';

/**
 * Persists Baileys WhatsApp Web credentials and Signal keys in SQLite,
 * encrypted at rest with AES-256-GCM.
 */
export async function useEncryptedSqliteAuthState(
  prisma: PrismaClient,
  encryptionKey: string,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  hasStoredCreds: () => Promise<boolean>;
  clearAll: () => Promise<void>;
}> {
  const writeData = async (key: string, data: unknown): Promise<void> => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    const encryptedValue = encryptSecret(json, encryptionKey);
    await prisma.whatsAppAuthEntry.upsert({
      where: { key },
      create: { key, encryptedValue },
      update: { encryptedValue },
    });
  };

  const readData = async <T = unknown>(key: string): Promise<T | null> => {
    const row = await prisma.whatsAppAuthEntry.findUnique({ where: { key } });
    if (!row) return null;
    try {
      const json = decryptSecret(row.encryptedValue, encryptionKey);
      return JSON.parse(json, BufferJSON.reviver) as T;
    } catch {
      return null;
    }
  };

  const removeData = async (key: string): Promise<void> => {
    await prisma.whatsAppAuthEntry.deleteMany({ where: { key } });
  };

  const storedCreds = await readData<AuthenticationCreds>('creds');
  const creds: AuthenticationCreds = storedCreds ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData<SignalDataTypeMap[T]>(`${type}:${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as unknown as Record<string, unknown>,
                ) as unknown as SignalDataTypeMap[T];
              }
              if (value !== null && value !== undefined) {
                data[id] = value;
              }
            }),
          );
          return data;
        },
        set: async (data: SignalDataSet) => {
          const ops: Array<Promise<void>> = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
            const entries = data[category];
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const storageKey = `${category}:${id}`;
              if (value) {
                ops.push(writeData(storageKey, value));
              } else {
                ops.push(removeData(storageKey));
              }
            }
          }
          await Promise.all(ops);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    hasStoredCreds: async () => {
      const row = await prisma.whatsAppAuthEntry.findUnique({ where: { key: 'creds' } });
      return Boolean(row);
    },
    clearAll: async () => {
      await prisma.whatsAppAuthEntry.deleteMany({});
    },
  };
}
