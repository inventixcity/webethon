import { z } from "zod";

/** Matches the API: 1 to 80 characters once trimmed, with no line breaks or control characters. */
export const teamNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the team")
    .max(80, "Use 80 characters or fewer")
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      error: "Remove line breaks and other control characters",
    }),
});

/** Matches the API's email rules: ASCII, one @, and non-empty parts. */
export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3, "Enter a valid email address")
    .max(254, "Enter a valid email address")
    .refine((value) => /^[\x21-\x7e]+@[\x21-\x7e]+$/.test(value) && value.split("@").length === 2, {
      error: "Enter a valid email address",
    }),
  role: z.enum(["admin", "member", "viewer"], { error: "Choose a role" }),
});

export type TeamNameValues = z.infer<typeof teamNameSchema>;
export type InviteValues = z.infer<typeof inviteSchema>;
