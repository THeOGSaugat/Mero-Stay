import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_RATE_LIMITS,
  DEFAULT_SESSION_TTL_HOURS,
  type AuthConfig,
} from "../modules/auth/auth.config.js";
import type { PaymentsConfig } from "../modules/payments/payments.config.js";
import {
  MAX_TRUST_PROXY_HOPS,
  parseTrustedAddresses,
  type TrustProxyConfig,
} from "../lib/client-ip.js";

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
    /**
     * Proxies in front of the API whose X-Forwarded-For entry is believed (ADR 0014): 0 = the API
     * is exposed directly, 1 = the MeroStay web server, 2 = web server + one edge/load balancer.
     * Required in production; default 1 elsewhere (the web server on this machine).
     */
    TRUST_PROXY_HOPS: z.preprocess(
      emptyAsUndefined,
      z.coerce.number().int().min(0).max(MAX_TRUST_PROXY_HOPS).optional(),
    ),
    /**
     * Addresses those proxies connect from (comma-separated IPs, CIDR ranges, or loopback,
     * linklocal, uniquelocal). Never "true" or a /0. Required in production when hops > 0;
     * default "loopback" elsewhere.
     */
    /**
     * Private document storage (ADR 0016): "local" (a directory on this machine) or "s3" (any
     * S3-compatible bucket). Required in production; default "local" elsewhere.
     */
    STORAGE_DRIVER: z.preprocess(emptyAsUndefined, z.enum(["local", "s3"]).optional()),
    /** Absolute directory for the local driver, outside any web root. Default: apps/api/.storage. */
    STORAGE_LOCAL_DIR: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .refine((dir) => isAbsolute(dir), { error: "must be an absolute directory" })
        .optional(),
    ),
    S3_BUCKET: z.preprocess(emptyAsUndefined, z.string().min(3).max(63).optional()),
    S3_REGION: z.preprocess(emptyAsUndefined, z.string().min(2).max(40).optional()),
    /** Only for S3-compatible stores (Cloudflare R2, MinIO, Backblaze); unset for AWS S3. */
    S3_ENDPOINT: z.preprocess(
      emptyAsUndefined,
      z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }).optional(),
    ),
    /** Optional: unset = the SDK's default credential chain (e.g. an instance role). */
    S3_ACCESS_KEY_ID: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    S3_SECRET_ACCESS_KEY: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    S3_FORCE_PATH_STYLE: z.preprocess(emptyAsUndefined, z.enum(["true", "false"]).optional()),
    TRUST_PROXY_ADDRESSES: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .transform((raw, ctx) => {
          try {
            return parseTrustedAddresses(raw);
          } catch (err) {
            ctx.addIssue({ code: "custom", message: (err as Error).message });
            return z.NEVER;
          }
        })
        .optional(),
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
    // The trusted-proxy chain is a security boundary (ADR 0014): production must state it.
    if (env.NODE_ENV === "production" && env.TRUST_PROXY_HOPS === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY_HOPS"],
        message:
          "is required in production (proxies in front of the API: 1 = the MeroStay web server, 0 = none)",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      (env.TRUST_PROXY_HOPS ?? 0) > 0 &&
      env.TRUST_PROXY_ADDRESSES === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TRUST_PROXY_ADDRESSES"],
        message: "is required in production when TRUST_PROXY_HOPS > 0 (the proxies' addresses)",
      });
    }
    // Verification documents need a deliberate storage choice in production (ADR 0016).
    if (env.NODE_ENV === "production" && env.STORAGE_DRIVER === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_DRIVER"],
        message: 'is required in production ("local" with STORAGE_LOCAL_DIR, or "s3")',
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.STORAGE_DRIVER === "local" &&
      env.STORAGE_LOCAL_DIR === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_LOCAL_DIR"],
        message: "is required in production with the local driver (a backed-up directory)",
      });
    }
    if (env.STORAGE_DRIVER === "s3") {
      for (const key of ["S3_BUCKET", "S3_REGION"] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "is required with STORAGE_DRIVER=s3",
          });
        }
      }
    }
    if ((env.S3_ACCESS_KEY_ID === undefined) !== (env.S3_SECRET_ACCESS_KEY === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["S3_SECRET_ACCESS_KEY"],
        message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together (or both unset)",
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

/** Development and tests: the web server runs on the same machine. */
const DEFAULT_DEV_TRUST_PROXY: TrustProxyConfig = { hops: 1, addresses: ["loopback"] };

/**
 * Trusted proxies for client-IP resolution (ADR 0014). The defaults apply outside production only:
 * parseEnv refuses production without explicit values.
 */
export function trustProxyConfigFromEnv(env: Env): TrustProxyConfig {
  return {
    hops: env.TRUST_PROXY_HOPS ?? DEFAULT_DEV_TRUST_PROXY.hops,
    addresses: env.TRUST_PROXY_ADDRESSES ?? DEFAULT_DEV_TRUST_PROXY.addresses,
  };
}

export type StorageConfig =
  | { driver: "local"; directory: string }
  | {
      driver: "s3";
      bucket: string;
      region: string;
      endpoint?: string;
      forcePathStyle: boolean;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    };

/** apps/api/.storage, from both src/config (tsx) and dist/config (node). Git-ignored. */
const DEFAULT_LOCAL_STORAGE_DIR = fileURLToPath(new URL("../../.storage", import.meta.url));

/** Document storage settings (ADR 0016). parseEnv already refused incomplete settings. */
export function storageConfigFromEnv(env: Env): StorageConfig {
  if (env.STORAGE_DRIVER === "s3") {
    return {
      driver: "s3",
      bucket: env.S3_BUCKET ?? "",
      region: env.S3_REGION ?? "",
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    };
  }
  return { driver: "local", directory: env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_STORAGE_DIR };
}

/** Online payment settings for the API server (ADR 0007). */
export function paymentsConfigFromEnv(env: Env): PaymentsConfig {
  return { gateway: env.PAYMENT_GATEWAY ?? null };
}
