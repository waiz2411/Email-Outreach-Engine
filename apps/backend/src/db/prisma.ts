import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import Database from 'better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';

export interface DatabaseBundle {
  prisma: PrismaClient;
  sqlite: Database.Database;
  close(): Promise<void>;
}

export async function createDatabaseBundle(databasePath: string): Promise<DatabaseBundle> {
  const sqlite = new Database(databasePath, { timeout: 5000 });
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  const adapter = new PrismaBetterSqlite3({
    url: `file:${databasePath}`,
    timeout: 5000,
  });

  const prisma = new PrismaClient({ adapter });
  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');

  return {
    prisma,
    sqlite,
    async close() {
      await prisma.$disconnect();
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Ignore checkpoint errors on close
      }
      sqlite.close();
    },
  };
}
