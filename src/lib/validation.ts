import { ensure } from './assertions.ts';
export { ensure } from './assertions.ts';
export { dateOnly } from './calendar.ts';

export function label(value: unknown, field: string): string {
  ensure(
    typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80,
    `${field} must contain 1–80 characters.`,
  );
  return value.trim();
}
const blockedNameWords = new Set([
  'admin',
  'administrator',
  'moderator',
  'fuck',
  'fucked',
  'fucker',
  'fuckers',
  'fucking',
  'fucks',
  'fuckface',
  'fuckhead',
  'fuk',
  'fukk',
  'phuck',
  'shit',
  'shits',
  'shitty',
  'shitting',
  'shithead',
  'bullshit',
  'bitch',
  'bitches',
  'bitchy',
  'bitchez',
  'cunt',
  'cunts',
  'cuntface',
  'nigger',
  'niggers',
  'nigga',
  'niggas',
  'faggot',
  'faggots',
  'fag',
  'fags',
  'retard',
  'retards',
  'retarded',
  'whore',
  'whores',
  'slut',
  'sluts',
  'asshole',
  'assholes',
]);
const leetLetters: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
};
function moderationWord(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[0-9]/g, (digit) => leetLetters[digit])
    .replace(/(\p{L})\1{2,}/gu, '$1');
}
export function participantName(value: unknown): string {
  ensure(typeof value === 'string', 'Enter your name.');
  const name = value.normalize('NFKC').trim().replace(/ +/g, ' ');
  ensure([...name].length >= 2 && [...name].length <= 20, 'Name must contain 2–20 characters.');
  ensure(
    /^[\p{L}\p{M}\p{N}]+(?:[ .'-][\p{L}\p{M}\p{N}]+)*\.?$/u.test(name),
    'Use letters, numbers, spaces, apostrophes, periods, or hyphens in your name.',
  );
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(moderationWord);
  const blocked = words.some((word, index) => {
    if (blockedNameWords.has(word)) return true;
    for (let end = index + 2; end <= Math.min(words.length, index + 8); end++) {
      if (blockedNameWords.has(words.slice(index, end).join(''))) return true;
    }
    return false;
  });
  ensure(!blocked, 'Choose an appropriate name.');
  return name;
}
export function positiveId(value: unknown): number {
  ensure(typeof value === 'number' || typeof value === 'string', 'Invalid selection.');
  const id = Number(value);
  ensure(Number.isSafeInteger(id) && id > 0, 'Choose a valid participant or competition.');
  return id;
}
