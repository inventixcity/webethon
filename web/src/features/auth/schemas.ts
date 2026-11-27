import { z } from "zod";

export const emailSchema = z.email("Enter a valid email address");
const email = emailSchema;
const newPassword = z.string().min(8, "Use at least 8 characters");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password"),
});

export const signupSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name"),
  email,
  password: newPassword,
  terms: z.literal(true, { error: "Accept the terms to continue" }),
});

export const forgotSchema = z.object({ email });

export const resetSchema = z
  .object({ password: newPassword, confirm: z.string() })
  .refine((values) => values.password === values.confirm, {
    path: ["confirm"],
    error: "The two passwords don't match",
  });

export type LoginValues = z.infer<typeof loginSchema>;
export type SignupValues = z.infer<typeof signupSchema>;
export type ForgotValues = z.infer<typeof forgotSchema>;
export type ResetValues = z.infer<typeof resetSchema>;

export const passwordRules = [
  { label: "8+ characters", test: (value: string) => value.length >= 8 },
  { label: "Upper and lower case", test: (value: string) => /[a-z]/.test(value) && /[A-Z]/.test(value) },
  { label: "A number", test: (value: string) => /\d/.test(value) },
  { label: "A symbol", test: (value: string) => /[^A-Za-z0-9]/.test(value) },
] as const;

export function passwordScore(value: string) {
  return passwordRules.filter((rule) => rule.test(value)).length;
}

export function maskEmail(address: string) {
  const [name = "", domain = ""] = address.split("@");
  if (!domain) return address;
  return `${name.slice(0, 1)}•••@${domain}`;
}
