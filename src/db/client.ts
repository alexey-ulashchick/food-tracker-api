import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../env.ts'
import * as schema from './schema.ts'

// In tests we provision a random Postgres schema per process and route all
// queries to it via search_path. See tests/setup.ts.
const testSchema = process.env.TEST_SCHEMA

const client = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  ...(testSchema ? { connection: { search_path: testSchema } } : {}),
})

export const db = drizzle(client, { schema })
export type Db = typeof db
