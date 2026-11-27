/** Change these values to rebrand the app on the day. */
export const siteConfig = {
  name: "Invigil",
  mark: "I",
  description: "Inventix Invigil: secure, failure-resilient online examinations.",
  tagline: "Exams that hold up.",
  contact: {
    email: "info@inventixhq.com",
    address: "COMSATS University Lahore, Pakistan",
    hours: "Mon–Fri, 9:00–17:00 PKT",
  },
  /** Which screens the real routes like /login use: 1 Editorial (padlock that follows the password), 2 Living, 3 Mechanical. */
  authSet: 1,
} as const;
