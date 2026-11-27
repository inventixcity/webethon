import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from './http.mjs';
import { extractCode } from './mail.mjs';
test('cookie jar handles multiple headers, equals and deletion', () => {
  const jar = new CookieJar();
  jar.store({ getSetCookie: () => ['session=abc==; Path=/; HttpOnly', 'reset=123; Path=/api'] });
  assert.equal(jar.header(), 'session=abc==; reset=123');
  jar.store({ getSetCookie: () => ['reset=; Max-Age=0; Path=/api'] });
  assert.equal(jar.header(), 'session=abc==');
});
test('extracts a six digit code from Mailpit text or HTML', () => {
  assert.equal(extractCode({ Text: 'Your code: 012345\nExpires in 15 minutes.' }), '012345');
  assert.equal(extractCode({ HTML: '<b>987654</b>' }), '987654');
  assert.equal(extractCode({ Text: '1234567' }), undefined);
});
