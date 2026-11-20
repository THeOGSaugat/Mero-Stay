import { z } from "zod";

/**
 * Emails are normalized before storage and lookup: trimmed and lower-cased (a CHECK constraint in
 * the database enforces this), so "Ram@Example.com " and "ram@example.com" are one account.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: "must be a valid email address" }));

/** A small block-list of passwords that meet the length rule but are trivially guessable. */
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "password1234",
  "password12345",
  "passwordpassword",
  "qwertyuiop12",
  "qwertyuiopasdf",
  "iloveyou1234",
  "aaaaaaaaaaaa",
  "abcdefghijkl",
  "merostay1234",
  "nepal1234567",
  "kathmandu123",
  "letmein12345",
  "welcome12345",
]);

/**
 * Password policy (ADR 0006): 12–128 characters (OWASP ASVS), any characters, no composition
 * rules, not on the common-password list. Checked on registration only, never on login.
 */
export const newPasswordSchema = z
  .string()
  .min(12, { error: "must be at least 12 characters" })
  .max(128, { error: "must be at most 128 characters" })
  .refine((password) => !COMMON_PASSWORDS.has(password.toLowerCase()), {
    error: "is too common; choose a less predictable password",
  });

export const registerBodySchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
    fullName: z.string().trim().min(1).max(200),
    /** Optional, E.164 (e.g. +9779812345678); spaces are removed. */
    phone: z
      .string()
      .transform((value) => value.replace(/\s+/g, ""))
      .pipe(
        z.string().regex(/^\+[1-9]\d{7,14}$/, {
          error: "must be in international format, e.g. +9779812345678",
        }),
      )
      .optional(),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerBodySchema>;

/** Login does not apply the password policy (old passwords must still work after a policy change). */
export const loginBodySchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(1024),
  })
  .strict();

export type LoginInput = z.infer<typeof loginBodySchema>;
