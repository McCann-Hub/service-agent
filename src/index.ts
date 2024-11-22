const WORLD = 'world';

export function hello(who: string = WORLD): string {
  return `Hello ${who}!`;
}
