import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_RATE_LIMITS,
  DEFAULT_SESSION_TTL_HOURS,
  type AuthConfig,
} from "../modules/auth/auth.config.js";
import type { PaymentsConfig } from "../modules/payments/payments.config.js";

/** Treat "VAR=" (empty) like an unset variable. */
const emptyAsUndefined = (value: unknown) => (value === "" ? undefined : value);

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
    /**
     * Signs CSRF tokens (ADR 0006). Required by the API server (not by CLI scripts).
     * Generate with: openssl rand -base64 48
     */
    SESSION_SECRET: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .min(32, { error: "must be at least 32 characters (openssl rand -base64 48)" })
        .optional(),
    ),
    /** Absolute session lifetime in hours (default 168 = 7 days). */
    SESSION_TTL_HOURS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(1).max(720).default(DEFAULT_SESSION_TTL_HOURS),
    ),
    /** Send the session cookie only over HTTPS. Default: true in production, false otherwise. */
    SESSION_COOKIE_SECURE: z.preprocess(emptyAsUndefined, z.enum(["true", "false"]).optional()),
    /**
     * Online payment gateway (ADR 0007). Only "simulated" exists this phase: payments are marked
     * succeeded by an API call instead of a real provider, so it is REFUSED in production. Unset =
     * online payments are unavailable (payment endpoints return 503). Explicit opt-in everywhere.
     */
    PAYMENT_GATEWAY: z.preprocess(emptyAsUndefined, z.enum(["simulated"]).optional()),
    /** How often the hold-release worker runs in --watch mode (default 60 s). */
    HOLD_RELEASE_INTERVAL_SECONDS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(5).max(3600).default(60),
    ),
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
    if (env.NODE_ENV === "production" && env.PAYMENT_GATEWAY === "simulated") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_GATEWAY"],
        message: "cannot be simulated in production (anyone could mark their own payment as paid)",
      });
    }
    if (env.NODE_ENV === "production" && env.SESSION_COOKIE_SECURE === "false") {
      ctx.addIssue({
        code: "custom",
        path: ["SESSION_COOKIE_SECURE"],
        message: "cannot be false in production (session cookies must be HTTPS-only)",
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

/**
 * Auth settings for the API server. Throws (and the server refuses to start) without a
 * SESSION_SECRET, so a deployment can never run with a missing or guessable secret.
 */
export function authConfigFromEnv(env: Env): AuthConfig {
  if (!env.SESSION_SECRET) {
    throw new Error(
      "Invalid environment configuration:\n  - SESSION_SECRET: is required (generate with: openssl rand -base64 48)",
    );
  }
  return {
    sessionSecret: env.SESSION_SECRET,
    sessionTtlMs: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    cookieSecure:
      env.SESSION_COOKIE_SECURE === undefined
        ? env.NODE_ENV === "production"
        : env.SESSION_COOKIE_SECURE === "true",
    rateLimits: DEFAULT_RATE_LIMITS,
  };
}

/** Online payment settings for the API server (ADR 0007). */
export function paymentsConfigFromEnv(env: Env): PaymentsConfig {
  return { gateway: env.PAYMENT_GATEWAY ?? null };
}
