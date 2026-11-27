/**
 * The names of the session cookie the API sets: plain in development, __Host- prefixed in production.
 * Only used as a routing hint. The API decides who is really signed in.
 */
export const SESSION_COOKIES = ["__Host-session", "session"] as const;
