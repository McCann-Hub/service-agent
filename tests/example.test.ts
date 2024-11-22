import { assertEquals } from 'jsr:@std/assert';
import { hello } from '../src/index.ts';

Deno.test('simple test', () => {
  const x = 1 + 2;
  assertEquals(x, 3);
});

Deno.test('default hello', () => {
  assertEquals(hello(), 'Hello world!');
});
