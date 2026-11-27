import { z } from "zod";

/** Accepts an empty string (no avatar) or an absolute https:// address. */
function isEmptyOrHttps(value: string): boolean {
  if (value === "") return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const profileSchema = z.object({
  displayName: z.string().trim(),
  avatarUrl: z.string().trim().refine(isEmptyOrHttps, {
    error: "Use a full address that starts with https://",
  }),
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "Use at least 8 characters"),
    confirm: z.string(),
  })
  .refine((values) => values.newPassword === values.confirm, {
    path: ["confirm"],
    error: "The two passwords don't match",
  });

export type ProfileValues = z.infer<typeof profileSchema>;
export type PasswordValues = z.infer<typeof passwordChangeSchema>;
