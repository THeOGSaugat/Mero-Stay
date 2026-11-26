import { describe, expect, it } from "vitest";
import { authConfigFromEnv, paymentsConfigFromEnv, parseEnv } from "./env.js";

const url =
  "postgresql://user:s3cret-pass@ep-test-pooler.eu-central-1.aws.neon.tech/db?sslmode=require";
const production = {
  DATABASE_URL: url,
  NODE_ENV: "production",
  TRUST_PROXY_HOPS: "1",
  TRUST_PROXY_ADDRESSES: "loopback",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "/var/lib/merostay/documents",
};
// Placeholders only (never real keys).
const esewaKeys = { ESEWA_PRODUCT_CODE: "EPAYTEST", ESEWA_SECRET_KEY: "placeholder-esewa-key" };
const khaltiKeys = { KHALTI_SECRET_KEY: "placeholder-khalti-key" };

function issues(env: Record<string, string>): string {
  try {
    parseEnv(env);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("payment gateway configuration (ADR 0017)", () => {
  it("production refuses to start without gateways, keys, mode and return URL", () => {
    expect(issues(production)).toMatch(/PAYMENT_GATEWAYS: is required in production/);
    const message = issues({ ...production, PAYMENT_GATEWAYS: "esewa,khalti" });
    expect(message).toMatch(/PAYMENT_MODE/);
    expect(message).toMatch(/ESEWA_PRODUCT_CODE: is required for esewa/);
    expect(message).toMatch(/ESEWA_SECRET_KEY: is required for esewa/);
    expect(message).toMatch(/KHALTI_SECRET_KEY: is required for khalti/);
    expect(message).toMatch(/PUBLIC_WEB_URL: is required/);
  });

  it("production needs https, the production mode, and no test URL overrides", () => {
    const base = {
      ...production,
      ...esewaKeys,
      PAYMENT_GATEWAYS: "esewa",
      PAYMENT_MODE: "production",
    };
    expect(issues({ ...base, PUBLIC_WEB_URL: "http://merostay.example" })).toMatch(
      /PUBLIC_WEB_URL: must be https/,
    );
    expect(
      issues({ ...base, PUBLIC_WEB_URL: "https://merostay.example", PAYMENT_MODE: "uat" }),
    ).toMatch(/PAYMENT_MODE/);
    expect(
      issues({
        ...base,
        PUBLIC_WEB_URL: "https://merostay.example",
        ESEWA_FORM_URL: "http://127.0.0.1:9/esewa/form",
      }),
    ).toMatch(/ESEWA_FORM_URL/);
    expect(issues({ ...base, PUBLIC_WEB_URL: "https://merostay.example" })).toBe("");
  });

  it("never echoes a secret in its errors", () => {
    const message = issues({
      ...production,
      PAYMENT_GATEWAYS: "esewa,khalti",
      ESEWA_SECRET_KEY: "esewa-secret-value-xyz",
      KHALTI_SECRET_KEY: "khalti-secret-value-xyz",
    });
    expect(message).not.toBe("");
    expect(message).not.toContain("esewa-secret-value-xyz");
    expect(message).not.toContain("khalti-secret-value-xyz");
  });

  it("builds UAT adapters by default and production URLs in production mode", () => {
    const uat = paymentsConfigFromEnv(
      parseEnv({
        DATABASE_URL: url,
        PAYMENT_GATEWAYS: "esewa,khalti",
        PUBLIC_WEB_URL: "http://localhost:3000/",
        ...esewaKeys,
        ...khaltiKeys,
      }),
    );
    expect(Object.keys(uat.gateways).sort()).toEqual(["esewa", "khalti"]);
    expect(uat.mode).toBe("uat");
    expect(uat.publicWebUrl).toBe("http://localhost:3000");
    const prod = paymentsConfigFromEnv(
      parseEnv({
        ...production,
        PAYMENT_GATEWAYS: "khalti",
        PAYMENT_MODE: "production",
        PUBLIC_WEB_URL: "https://merostay.example",
        ...khaltiKeys,
      }),
    );
    expect(Object.keys(prod.gateways)).toEqual(["khalti"]);
    expect(prod.mode).toBe("production");
  });

  it("the per-client login limit can be raised for tests only, never in production", () => {
    expect(issues({ ...production, AUTH_LOGIN_PER_IP_LIMIT: "300" })).toMatch(
      /AUTH_LOGIN_PER_IP_LIMIT: is for tests only/,
    );
    const env = parseEnv({
      DATABASE_URL: url,
      AUTH_LOGIN_PER_IP_LIMIT: "300",
      SESSION_SECRET: "x".repeat(40),
    });
    const auth = authConfigFromEnv(env);
    expect(auth.rateLimits.loginPerIp.limit).toBe(300);
    expect(auth.rateLimits.loginPerEmail.limit).toBe(10); // never changed
    expect(
      authConfigFromEnv(parseEnv({ DATABASE_URL: url, SESSION_SECRET: "x".repeat(40) })).rateLimits
        .loginPerIp.limit,
    ).toBe(30);
  });

  it("refuses the old PAYMENT_GATEWAY setting instead of ignoring it", () => {
    expect(issues({ DATABASE_URL: url, PAYMENT_GATEWAY: "simulated" })).toMatch(
      /PAYMENT_GATEWAY: was renamed to PAYMENT_GATEWAYS/,
    );
  });

  it("needs keys for each enabled gateway outside production too", () => {
    expect(issues({ DATABASE_URL: url, PAYMENT_GATEWAYS: "khalti" })).toMatch(
      /KHALTI_SECRET_KEY: is required for khalti/,
    );
    expect(paymentsConfigFromEnv(parseEnv({ DATABASE_URL: url })).gateways).toEqual({});
  });
});
