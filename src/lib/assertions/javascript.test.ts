import { describe, it, expect } from 'vitest';
import { createJavascriptAssertion } from './javascript';
import type { AssertionProvider, AssertionResult, NormalizedTestCase, FileReference } from '$lib/types';
import { CodeReference } from '$lib/storage/CodeReference';

// Updated context type to match src/lib/types.ts
type MockAssertionRunContext = {
  provider: { id: string | null; labeled?: Record<string, { id: string }> };
  prompt: { prompt: string }; // Simplified NormalizedPrompt
  allOutputsInColumn?: ((string | FileReference | (string | FileReference)[] | undefined))[] | undefined;
};

const baseMockContext: Omit<MockAssertionRunContext, 'allOutputsInColumn'> = { // Base context without allOutputsInColumn
  provider: { id: 'test-provider' },
  prompt: { prompt: 'test-prompt' },
};

// Helper to create a mock FileReference (actual FileReference might have more properties)
const createFileRef = (uri: string): FileReference => ({
  uri,
  name: uri.substring(uri.lastIndexOf('/') + 1),
  type: 'image/png', // Example type
  content: new Uint8Array(), // Empty content for mock
  blob: new Blob(),
});


describe('createJavascriptAssertion', () => {
  describe('Existing Basic Functionality', () => {
    it('should return pass: true with simple code and no allOutputs', async () => {
      const assertionProvider = createJavascriptAssertion(
        { code: 'return { pass: true, message: "Basic pass" };' },
        {}, // testVars
      );
      const result = await assertionProvider.run('current output', { ...baseMockContext }); // No allOutputsInColumn
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Basic pass');
    });

    it('should access testVars correctly', async () => {
      const assertionProvider = createJavascriptAssertion(
        { code: 'return { pass: context.vars.expected === "hello" };' },
        { expected: 'hello' },
      );
      const result = await assertionProvider.run('current output', { ...baseMockContext });
      expect(result.pass).toBe(true);
    });
  });

  describe('Accessing allOutputs (with potentially nested structure)', () => {
    const accessCode = `
      // output is the current cell's output
      // context.allOutputs is the array of all outputs in the column
      if (context.allOutputs === undefined) return { pass: false, message: "allOutputs is undefined in context" };
      if (!Array.isArray(context.allOutputs)) return { pass: false, message: "allOutputs is not an array" };
      
      // Use JSON.stringify for comparison to handle arrays and primitives consistently
      // Note: This is a simplification and might not be robust for complex objects like FileReference if specific properties need comparison.
      const currentOutputString = JSON.stringify(output);
      const found = context.allOutputs.some(item => JSON.stringify(item) === currentOutputString);
      
      if (!found) return { pass: false, message: "current output not found in allOutputs using deep check" };
      return { pass: true, message: \`Received \${context.allOutputs.length} total outputs.\` };
    `;

    it('should correctly access allOutputs including nested arrays', async () => {
      const assertionProvider = createJavascriptAssertion({ code: accessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['outputA', ['outputB_nested', 'outputB_extra'], 'outputC', undefined],
      };
      // Test finding a simple string
      let result = await assertionProvider.run('outputA', mockRunContext);
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Received 4 total outputs.');

      // Test finding a nested array
      result = await assertionProvider.run(['outputB_nested', 'outputB_extra'], mockRunContext);
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Received 4 total outputs.');
    });

    it('should fail if current output (array) is not in allOutputs', async () => {
      const assertionProvider = createJavascriptAssertion({ code: accessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['outputA', ['outputD_nested'], 'outputC'],
      };
      const result = await assertionProvider.run(['outputB_nested'], mockRunContext); // This specific array is not present
      expect(result.pass).toBe(false);
      expect(result.message).toBe('current output not found in allOutputs using deep check');
    });
  });

  describe('Uniqueness Check (Row-Specific with potentially nested allOutputs)', () => {
    const uniquenessCode = `
      // output = current cell's output (e.g., "apple" or ["apple", "red"])
      // context.allOutputs = column data (e.g., ["orange", ["apple", "red"], "banana", "apple"])
      // Note: JSON.stringify is used for comparison. This is a simplification and may not be ideal for all types (e.g., FileReference).
      // For FileReference, one might compare a specific property like 'uri'.
      if (!context.allOutputs) return { pass: false, message: "allOutputs not provided" };
      
      let occurrences = 0;
      const currentOutputString = JSON.stringify(output);

      for (const item of context.allOutputs) {
        if (JSON.stringify(item) === currentOutputString) {
          occurrences++;
        }
      }

      if (occurrences > 1) {
        return { pass: false, message: \`Value '\${currentOutputString}' is duplicated (\${occurrences} times).\` };
      }
      return { pass: true };
    `;

    it('Scenario 1 (Corrected): currentOutput (string) is present once among various types', async () => {
      const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['orange', ['banana', 'seed'], 'apple', 'kiwi', undefined],
      };
      const result = await assertionProvider.run('apple', mockRunContext); // 'apple' appears once
      expect(result.pass).toBe(true);
    });

    it('Scenario 2: currentOutput (string) is duplicated', async () => {
      const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', 'apple', undefined],
      };
      const result = await assertionProvider.run('apple', mockRunContext); // 'apple' appears twice
      expect(result.pass).toBe(false);
      expect(result.message).toBe("Value '\"apple\"' is duplicated (2 times).");
    });

    it('Scenario 3: currentOutput (array) is duplicated', async () => {
      const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', ['banana', 'seed'], undefined],
      };
      const result = await assertionProvider.run(['banana', 'seed'], mockRunContext); // ['banana', 'seed'] appears twice
      expect(result.pass).toBe(false);
      expect(result.message).toBe("Value '[\"banana\",\"seed\"]' is duplicated (2 times).");
    });

    it('Scenario 4: currentOutput (array) is unique', async () => {
      const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', undefined],
      };
      const result = await assertionProvider.run(['grape', 'vine'], mockRunContext); // ['grape', 'vine'] appears once (not present before)
      expect(result.pass).toBe(true);
    });

    it('Scenario 5: currentOutput (string) is unique even if a substring of a nested array item', async () => {
        const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
        const mockRunContext: MockAssertionRunContext = {
          ...baseMockContext,
          allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange'],
        };
        // 'banana' is not identical to ['banana', 'seed'] when stringified
        const result = await assertionProvider.run('banana', mockRunContext);
        expect(result.pass).toBe(true);
    });

    it('Uniqueness check with FileReference (comparing URI via modified code)', async () => {
      // For FileReference, stringify is not good. We need to adapt the JS code for a real-world scenario.
      // This test simulates JS code that would intelligently compare FileReferences by URI.
      const uniquenessCodeWithFileRef = `
        if (!context.allOutputs) return { pass: false, message: "allOutputs not provided" };
        
        let occurrences = 0;
        // Helper to get a comparable value (URI for FileRef, or the value itself for primitives/arrays)
        const getComparable = (val) => {
          if (val && typeof val === 'object' && val.uri && val.blob instanceof Blob) { // Heuristic for FileReference-like
            return val.uri;
          }
          return JSON.stringify(val); // Fallback for other types
        };

        const currentOutputComparable = getComparable(output);

        for (const item of context.allOutputs) {
          if (getComparable(item) === currentOutputComparable) {
            occurrences++;
          }
        }

        if (occurrences > 1) {
          return { pass: false, message: \`Value (comparable form: '\${currentOutputComparable}') is duplicated (\${occurrences} times).\` };
        }
        return { pass: true };
      `;
      const assertionProvider = createJavascriptAssertion({ code: uniquenessCodeWithFileRef }, {});
      
      const fileRef1 = createFileRef('file:///image.png');
      const fileRef2 = createFileRef('file:///other.png');
      const fileRef1Dup = createFileRef('file:///image.png'); // Same URI as fileRef1

      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: [fileRef1, fileRef2, 'some string', fileRef1Dup, ['array', 'item']],
      };
      
      // Test duplicate FileReference
      let result = await assertionProvider.run(fileRef1, mockRunContext);
      expect(result.pass).toBe(false);
      expect(result.message).toBe("Value (comparable form: 'file:///image.png') is duplicated (2 times).");

      // Test unique FileReference
      result = await assertionProvider.run(fileRef2, mockRunContext);
      expect(result.pass).toBe(true);

      // Test unique string when FileReferences are present
      result = await assertionProvider.run('some string', mockRunContext);
      expect(result.pass).toBe(true);
      
      // Test unique array when FileReferences are present
      result = await assertionProvider.run(['array', 'item'], mockRunContext);
      expect(result.pass).toBe(true);
    });

  });

  describe('Handling Empty/Undefined allOutputs', () => {
    const gracefulCode = `
      if (context.allOutputs && context.allOutputs.length > 0) {
        // Logic that would use allOutputs
      }
      return { pass: true, message: "Handled potentially missing or empty allOutputs" };
    `;

    it('should pass if allOutputsInColumn is undefined in context', async () => {
      const assertionProvider = createJavascriptAssertion({ code: gracefulCode }, {});
      const result = await assertionProvider.run('some output', { ...baseMockContext }); // allOutputsInColumn is undefined
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Handled potentially missing or empty allOutputs');
    });

    it('should pass if allOutputsInColumn is an empty array in context', async () => {
      const assertionProvider = createJavascriptAssertion({ code: gracefulCode }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: [],
      };
      const result = await assertionProvider.run('some output', mockRunContext);
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Handled potentially missing or empty allOutputs');
    });
  });

  describe('CodeReference with allOutputs (nested)', () => {
    it('should work with CodeReference and access nested allOutputs', async () => {
       const codeAsString = `
        if (context.allOutputs === undefined) return { pass: false, message: "allOutputs is undefined in context" };
        const currentOutputString = JSON.stringify(output);
        const found = context.allOutputs.some(item => JSON.stringify(item) === currentOutputString);
        if (!found) return { pass: false, message: "current output not in allOutputs via CodeRef" };
        return { pass: true, message: \`Received \${context.allOutputs.length} total outputs via CodeRef.\` };
      `;
      const codeRef = new CodeReference(codeAsString);
      const assertionProvider = createJavascriptAssertion({ code: codeRef }, {});
      const mockRunContext: MockAssertionRunContext = {
        ...baseMockContext,
        allOutputsInColumn: ['refA', ['refB_nested'], undefined],
      };
      const result = await assertionProvider.run(['refB_nested'], mockRunContext);
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Received 3 total outputs via CodeRef.');
    });
  });
});
