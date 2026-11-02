import { describe, it, expect } from 'vitest';
import { buildProblemPayload, collectErrorMessages, alternateSolutionFields } from './problemForm';

describe('problemForm Utility', () => {
  describe('buildProblemPayload', () => {
    it('trims strings and normalizes parameters', () => {
      const formData = {
        title: '  Two Sum  ',
        description: '  Description  ',
        functionName: 'twoSum',
        returnType: 'number',
        parameters: [
          { name: '  a  ', type: '  number  ' }
        ],
        testCases: [
          { inputs: '[1]', expected: '1', isSample: true }
        ],
        referenceSolution: 'return a;',
        solutionLanguage: 'javascript',
        difficulty: 'Easy',
        tags: 'array, math',
        isPremium: true
      };

      const { payload, errors } = buildProblemPayload(formData);
      
      expect(errors).toEqual({});
      expect(payload.title).toBe('Two Sum');
      expect(payload.description).toBe('Description');
      expect(payload.parameters[0].name).toBe('a');
      expect(payload.parameters[0].type).toBe('number');
      expect(payload.tags).toEqual(['array', 'math']);
      expect(payload.isPremium).toBe(true);
    });

    it('returns errors for empty fields', () => {
      const formData = {};
      const { errors } = buildProblemPayload(formData);
      expect(Object.keys(errors).length).toBeGreaterThan(0);
      expect(errors.title).toBeDefined();
    });
  });

  describe('collectErrorMessages', () => {
    it('returns array of error messages', () => {
      const errors = {
        title: 'Title is required',
        difficulty: 'Difficulty is invalid'
      };
      const messages = collectErrorMessages(errors);
      expect(messages).toContain('Title is required');
      expect(messages).toContain('Difficulty is invalid');
      expect(messages.length).toBe(2);
    });
  });

  describe('alternateSolutionFields (P11)', () => {
    it('sends the second solution with its language, defaulting to the one the picker shows', () => {
      expect(alternateSolutionFields({ alternateSolution: 'brute', alternateSolutionLanguage: 'cpp' }))
        .toEqual({ alternateSolution: 'brute', alternateSolutionLanguage: 'cpp' });
      expect(alternateSolutionFields({ alternateSolution: 'brute' }))
        .toEqual({ alternateSolution: 'brute', alternateSolutionLanguage: 'python' });
    });

    it('sends blanks when there is none, so an edit can remove it', () => {
      expect(alternateSolutionFields({ alternateSolution: '  \n', alternateSolutionLanguage: 'cpp' }))
        .toEqual({ alternateSolution: '', alternateSolutionLanguage: '' });
      expect(alternateSolutionFields({})).toEqual({ alternateSolution: '', alternateSolutionLanguage: '' });
    });
  });
});
