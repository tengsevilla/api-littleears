import { defineConfig } from "vitest/config";

// Test env: mock providers and dummy (non-secret) values. Tests never read .env
// and never touch a real DB — lib/db.ts is mocked per test.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      PORT: "3001",
      CORS_ORIGIN: "http://localhost:3000",
      DB_HOST: "127.0.0.1",
      DB_PORT: "3306",
      DB_USER: "test",
      DB_PASSWORD: "test",
      DB_NAME: "littleears_test",
      JWT_SECRET: "test-jwt-secret-test-jwt-secret-0000",
      JWT_REFRESH_SECRET: "test-refresh-secret-test-refresh-0000",
      LYRICS_PROVIDER: "mock",
      MUSIC_PROVIDER: "mock",
      IMAGE_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      S3_BUCKET: "littleears-test",
      S3_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test",
      AWS_SECRET_ACCESS_KEY: "test",
      WORKER_POLL_MS: "2000",
      WORKER_MAX_ATTEMPTS: "3",
    },
  },
});
