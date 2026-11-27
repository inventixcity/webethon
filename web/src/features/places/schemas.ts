import { z } from "zod";

/** The form's rules. The API checks them again, so these messages are only for quick feedback. */
export const placeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Add a name for this place.")
    .max(120, "Use at most 120 characters."),
  description: z.string().max(2000, "Use at most 2000 characters."),
  address: z.string().max(300, "Use at most 300 characters."),
  category: z.string().max(40, "Use at most 40 characters."),
  visibility: z.enum(["private", "public"]),
  lat: z
    .number({ error: "Enter a latitude between -90 and 90." })
    .min(-90, "Latitude must be at least -90.")
    .max(90, "Latitude must be at most 90."),
  lng: z
    .number({ error: "Enter a longitude between -180 and 180." })
    .min(-180, "Longitude must be at least -180.")
    .max(180, "Longitude must be at most 180."),
});

export type PlaceValues = z.infer<typeof placeSchema>;
