import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const dbPath = process.env.DATABASE_PATH || './data/outreach-engine.db';
const resolvedDbUrl =
  process.env.DATABASE_URL ||
  `file:${path.resolve(process.cwd(), dbPath)}`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: resolvedDbUrl,
  },
});
