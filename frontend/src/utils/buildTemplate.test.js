import { describe, it, expect } from 'vitest';
import buildTemplate from './buildTemplate';

describe('buildTemplate Utility', () => {
  it('generates correct Java template for linkedlist<number>', () => {
    const language = 'java';
    const functionName = 'reverseList';
    const parameters = [{ name: 'head', type: 'linkedlist<number>' }];
    const returnType = 'linkedlist<number>';
    
    const template = buildTemplate(language, functionName, parameters, returnType);
    
    expect(template).toContain('public ListNode reverseList(ListNode head)');
    expect(template).toContain('class ListNode');
    expect(template).toContain('import java.util.*;');
  });

  it('generates correct Java template for tree<number>', () => {
    const language = 'java';
    const functionName = 'maxDepth';
    const parameters = [{ name: 'root', type: 'tree<number>' }];
    const returnType = 'number';
    
    const template = buildTemplate(language, functionName, parameters, returnType);
    
    expect(template).toContain('public int maxDepth(TreeNode root)');
    expect(template).toContain('class TreeNode');
  });

  it('generates correct Java template for array<number>', () => {
    const language = 'java';
    const functionName = 'twoSum';
    const parameters = [
      { name: 'nums', type: 'array<number>' },
      { name: 'target', type: 'number' }
    ];
    const returnType = 'array<number>';
    
    const template = buildTemplate(language, functionName, parameters, returnType);
    
    expect(template).toContain('public int[] twoSum(int[] nums, int target)');
  });

  it('generates correct Python template', () => {
    const language = 'python';
    const functionName = 'twoSum';
    const parameters = [
      { name: 'nums', type: 'array<number>' },
      { name: 'target', type: 'number' }
    ];
    
    const template = buildTemplate(language, functionName, parameters);
    
    expect(template).toContain('def twoSum(nums, target):');
  });

  it('generates correct JavaScript template', () => {
    const language = 'javascript';
    const functionName = 'twoSum';
    const parameters = [
      { name: 'nums', type: 'array<number>' },
      { name: 'target', type: 'number' }
    ];
    
    const template = buildTemplate(language, functionName, parameters);
    
    expect(template).toContain('function twoSum(nums, target) {');
  });

  it('generates correct TypeScript template', () => {
    const language = 'typescript';
    const functionName = 'twoSum';
    const parameters = [
      { name: 'nums', type: 'array<number>' },
      { name: 'target', type: 'number' }
    ];
    const returnType = 'array<number>';
    
    const template = buildTemplate(language, functionName, parameters, returnType);
    
    expect(template).toContain('function twoSum(nums: number[], target: number): number[]');
  });

  it('generates correct TypeScript template for linkedlist<number>', () => {
    const language = 'typescript';
    const functionName = 'reverseList';
    const parameters = [{ name: 'head', type: 'linkedlist<number>' }];
    const returnType = 'linkedlist<number>';
    
    const template = buildTemplate(language, functionName, parameters, returnType);
    
    expect(template).toContain('function reverseList(head: ListNode | null): ListNode | null');
    expect(template).toContain('class ListNode');
  });
});

describe('starter code returns a value of the declared type', () => {
  const tpl = (lang, returnType, params = [{ name: 'nums', type: 'array<number>' }]) => buildTemplate(lang, 'solve', params, returnType);

  it.each([
    ['java', 'number', 'return 0;'],
    ['java', 'array<number>', 'return new int[0];'],
    ['java', 'matrix<number>', 'return new int[0][];'],
    ['java', 'tree<number>', 'return null;'],
    ['cpp', 'number', 'return 0;'],
    ['cpp', 'array<number>', 'return {};'],
    ['cpp', 'linkedlist<number>', 'return nullptr;'],
    ['csharp', 'string', 'return "";'],
    ['csharp', 'array<string>', 'return new string[0];'],
    ['kotlin', 'boolean', 'return false'],
    ['kotlin', 'array<number>', 'return arrayOf()'],
    ['rust', 'number', 'return 0;'],
    ['rust', 'string', 'return String::new();'],
    ['rust', 'array<number>', 'return Vec::new();'],
    ['go', 'number', 'return 0'],
    ['go', 'tree<number>', 'return nil'],
    ['c', 'array<number>', 'return NULL;'],
    ['c', 'boolean', 'return false;'],
    ['typescript', 'array<number>', 'return [];'],
  ])('%s %s -> %s', (lang, returnType, line) => {
    expect(tpl(lang, returnType)).toContain(line);
  });

  it('adds no return for void, and none in the dynamic languages', () => {
    for (const lang of ['java', 'cpp', 'csharp', 'kotlin', 'rust', 'go', 'c', 'typescript']) {
      expect(tpl(lang, 'void')).not.toMatch(/\breturn\b/);
    }
    for (const lang of ['python', 'javascript', 'ruby', 'php']) {
      expect(tpl(lang, 'number')).not.toMatch(/\breturn\b/);
    }
  });
});
