import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Environment variables the API needs. Validated once at startup so that a
 * misconfigured deployment fails fast instead of failing on the first request.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    /** Pooled Neon connection used by the running API. */
    DATABASE_URL: z
      .string({ error: "is required" })
      .regex(/^postgres(ql)?:\/\//, { error: "must be a postgresql:// connection string" }),
  })
  .superRefine((env, ctx) => {
    // Neon only accepts TLS connections. In production, refuse to start without it
    // so credentials are never sent over an unencrypted link.
    if (
      env.NODE_ENV === "production" &&
      !/[?&]sslmode=(require|verify-ca|verify-full)\b/.test(env.DATABASE_URL)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "must include sslmode=require in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates environment variables.
 * Error messages name the invalid variables but never echo their values,
 * because values such as DATABASE_URL contain credentials.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

/**
 * Loads `apps/api/.env` into process.env if the file exists (local development).
 * Existing environment variables are not overridden. In production the file
 * is normally absent and real environment variables are used.
 */
export function loadEnvFileIfPresent(): void {
  // The test runner sets this so tests can never read the dev database URL from .env.
  if (process.env.MEROSTAY_SKIP_ENV_FILE === "1") return;
  // Resolves to apps/api/.env from both src/config (tsx) and dist/config (node).
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}
