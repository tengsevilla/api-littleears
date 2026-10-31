import mysql from "mysql2/promise";
import { env } from "./env.js";

const baseConfig = {
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  charset: "utf8mb4",
  timezone: "Z",
} as const;

// Single shared pool for the app.
// MariaDB: JSON is a LONGTEXT alias, so JSON columns come back as strings — JSON.parse in models.
export const db = mysql.createPool({
  ...baseConfig,
  connectionLimit: 10,
  waitForConnections: true,
});

// Used only by the migration runner: migration files contain several statements.
export function createMigrationConnection() {
  return mysql.createConnection({ ...baseConfig, multipleStatements: true });
}
