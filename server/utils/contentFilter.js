import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Filter = require('bad-words');
const _filter = new Filter();

export function isProfane(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  try {
    return _filter.isProfane(str);
  } catch {
    return false;
  }
}
