import { describe, it, expect, beforeEach } from 'vitest';
import { switchLanguage, hasOwnWork, loadPracticeCode, savePracticeCode } from './codeDrafts';
import { starterCode } from './buildTemplate';

const problem = { _id: 'p1', problemType: 'function', functionName: 'sumList', parameters: [{ name: 'nums', type: 'array<number>' }], returnType: 'number' };

describe('switchLanguage', () => {
  it('gives a language not used yet its starter code and keeps the code being left', () => {
    const { byLang, code } = switchLanguage({}, 'python', 'def sumList(nums):\n    return sum(nums)', 'cpp', problem);
    expect(code).toBe(starterCode('cpp', problem));
    expect(byLang.python).toBe('def sumList(nums):\n    return sum(nums)');
  });

  it('brings back what was written when switching back', () => {
    let state = switchLanguage({}, 'python', 'my python', 'java', problem);
    state = switchLanguage(state.byLang, 'java', 'my java', 'python', problem);
    expect(state.code).toBe('my python');
    expect(switchLanguage(state.byLang, 'python', 'my python v2', 'java', problem).code).toBe('my java');
  });

  it('keeps an emptied editor empty instead of refilling it', () => {
    const state = switchLanguage({}, 'python', '', 'java', problem);
    expect(switchLanguage(state.byLang, 'java', 'x', 'python', problem).code).toBe('');
  });
});

describe('hasOwnWork', () => {
  it('is false for the untouched starter code and true once edited', () => {
    expect(hasOwnWork(starterCode('java', problem), 'java', problem)).toBe(false);
    expect(hasOwnWork(starterCode('java', problem) + '\n// idea', 'java', problem)).toBe(true);
  });
});

describe('practice code storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips per user and problem', () => {
    savePracticeCode('u1', 'p1', 'cpp', { cpp: 'int x;', python: 'pass' });
    expect(loadPracticeCode('u1', 'p1')).toMatchObject({ language: 'cpp', byLang: { cpp: 'int x;', python: 'pass' } });
    expect(loadPracticeCode('u2', 'p1')).toBeNull();
    expect(loadPracticeCode('u1', 'p2')).toBeNull();
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem('practice-code:u1:p1', '{not json');
    expect(loadPracticeCode('u1', 'p1')).toBeNull();
  });
});
