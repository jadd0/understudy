import { sql } from "drizzle-orm";
import { pgTable, uuid } from "drizzle-orm/pg-core";

// Foreign-key targets for the engine's tables: only the `id` column, under the host's table names. These are never
// exported from the package entry and never create or alter anything; the host's own schema defines the full tables.

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

export const users = pgTable("users", { id: id() });
export const creators = pgTable("creators", { id: id() });
export const catalogueItems = pgTable("catalogue_items", { id: id() });
