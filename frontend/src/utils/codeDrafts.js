import { starterCode } from './buildTemplate';

// Code is kept per language, so switching to C++ and back to Python brings the Python code
// back. A language not written in yet gets its starter code.

// Remember the code being left, then return the code for the language being switched to.
export function switchLanguage(byLang, fromLang, currentCode, toLang, problem) {
  const next = { ...(byLang || {}) };
  if (fromLang) next[fromLang] = currentCode;
  const code = typeof next[toLang] === 'string' ? next[toLang] : starterCode(toLang, problem);
  return { byLang: next, code };
}

// True when the code differs from the starter code, i.e. resetting would lose work.
export function hasOwnWork(code, language, problem) {
  return (code || '').trim() !== starterCode(language, problem).trim();
}

// Practice page: the last language and each language's code, in this browser only.
// Keyed by user so a shared lab computer doesn't show one student's code to the next.
const practiceKey = (userId, problemId) => `practice-code:${userId || 'guest'}:${problemId}`;

export function loadPracticeCode(userId, problemId) {
  try {
    const saved = JSON.parse(localStorage.getItem(practiceKey(userId, problemId)) || 'null');
    if (saved && typeof saved.language === 'string' && saved.byLang && typeof saved.byLang === 'object') return saved;
  } catch {
    // unreadable or blocked storage: start fresh
  }
  return null;
}

export function savePracticeCode(userId, problemId, language, byLang) {
  try {
    localStorage.setItem(practiceKey(userId, problemId), JSON.stringify({ language, byLang, savedAt: Date.now() }));
  } catch {
    // storage full or blocked: the code still lives in the editor
  }
}
