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

const baseMockContextWithoutColumnOutputs: Omit<MockAssertionRunContext, 'allOutputsInColumn'> = {
  provider: { id: 'test-provider' },
  prompt: { prompt: 'test-prompt' },
};

// Helper to create a mock FileReference
const createFileRef = (uri: string): FileReference => ({
  uri,
  name: uri.substring(uri.lastIndexOf('/') + 1),
  type: 'image/png',
  content: new Uint8Array(),
  blob: new Blob(),
});


describe('createJavascriptAssertion', () => {
  describe('Simulating columnAware: false (or flag absent)', () => {
    it('should return pass: true with simple code when allOutputsInColumn is not in context', async () => {
      const assertionProvider = createJavascriptAssertion(
        { code: 'return { pass: true, message: "Basic pass" };' },
        {}, // testVars
      );
      // Pass context without allOutputsInColumn
      const result = await assertionProvider.run('current output', { ...baseMockContextWithoutColumnOutputs });
      expect(result.pass).toBe(true);
      expect(result.message).toBe('Basic pass');
    });

    it('should access testVars correctly when allOutputsInColumn is not in context', async () => {
      const assertionProvider = createJavascriptAssertion(
        { code: 'return { pass: context.vars.expected === "hello" };' },
        { expected: 'hello' },
      );
      const result = await assertionProvider.run('current output', { ...baseMockContextWithoutColumnOutputs });
      expect(result.pass).toBe(true);
    });

    it('context.allOutputs should be undefined in JS code if allOutputsInColumn is not provided in context', async () => {
      const jsCode = 'return { pass: context.allOutputs === undefined, message: "allOutputs is " + String(context.allOutputs) };';
      const assertionProvider = createJavascriptAssertion({ code: jsCode }, {});
      // Pass context without allOutputsInColumn
      const result = await assertionProvider.run('any output', { ...baseMockContextWithoutColumnOutputs });
      expect(result.pass).toBe(true);
      expect(result.message).toBe('allOutputs is undefined');
    });

    it('should execute simple logic without depending on allOutputs', async () => {
      const jsCode = 'return { pass: output === "expected_output" && context.vars.someVar === "var_value" };';
      const assertionProvider = createJavascriptAssertion(
        { code: jsCode },
        { someVar: "var_value" } // testVars
      );
      const result = await assertionProvider.run("expected_output", { ...baseMockContextWithoutColumnOutputs });
      expect(result.pass).toBe(true);
    });
  });

  describe('Simulating columnAware: true (allOutputsInColumn is provided in context)', () => {
    // Existing tests from "Accessing allOutputs", "Uniqueness Check", "CodeReference with allOutputs"
    // are moved here as they represent the columnAware: true scenario by providing allOutputsInColumn.

    describe('Accessing allOutputs (with potentially nested structure)', () => {
      const accessCode = `
        // output is the current cell's output
        // context.allOutputs is the array of all outputs in the column
        if (context.allOutputs === undefined) return { pass: false, message: "allOutputs is undefined in context" };
        if (!Array.isArray(context.allOutputs)) return { pass: false, message: "allOutputs is not an array" };
        
        const currentOutputString = JSON.stringify(output);
        const found = context.allOutputs.some(item => JSON.stringify(item) === currentOutputString);
        
        if (!found) return { pass: false, message: "current output not found in allOutputs using deep check" };
        return { pass: true, message: \`Received \${context.allOutputs.length} total outputs.\` };
      `;

      it('should correctly access allOutputs including nested arrays', async () => {
        const assertionProvider = createJavascriptAssertion({ code: accessCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['outputA', ['outputB_nested', 'outputB_extra'], 'outputC', undefined],
        };
        let result = await assertionProvider.run('outputA', mockRunContextWithColumn);
        expect(result.pass).toBe(true);
        expect(result.message).toBe('Received 4 total outputs.');

        result = await assertionProvider.run(['outputB_nested', 'outputB_extra'], mockRunContextWithColumn);
        expect(result.pass).toBe(true);
        expect(result.message).toBe('Received 4 total outputs.');
      });

      it('should fail if current output (array) is not in allOutputs', async () => {
        const assertionProvider = createJavascriptAssertion({ code: accessCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['outputA', ['outputD_nested'], 'outputC'],
        };
        const result = await assertionProvider.run(['outputB_nested'], mockRunContextWithColumn);
        expect(result.pass).toBe(false);
        expect(result.message).toBe('current output not found in allOutputs using deep check');
      });
    });

    describe('Uniqueness Check (Row-Specific with potentially nested allOutputs)', () => {
      const uniquenessCode = `
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
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['orange', ['banana', 'seed'], 'apple', 'kiwi', undefined],
        };
        const result = await assertionProvider.run('apple', mockRunContextWithColumn);
        expect(result.pass).toBe(true);
      });

      it('Scenario 2: currentOutput (string) is duplicated', async () => {
        const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', 'apple', undefined],
        };
        const result = await assertionProvider.run('apple', mockRunContextWithColumn);
        expect(result.pass).toBe(false);
        expect(result.message).toBe("Value '\"apple\"' is duplicated (2 times).");
      });

      it('Scenario 3: currentOutput (array) is duplicated', async () => {
        const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', ['banana', 'seed'], undefined],
        };
        const result = await assertionProvider.run(['banana', 'seed'], mockRunContextWithColumn);
        expect(result.pass).toBe(false);
        expect(result.message).toBe("Value '[\"banana\",\"seed\"]' is duplicated (2 times).");
      });

      it('Scenario 4: currentOutput (array) is unique', async () => {
        const assertionProvider = createJavascriptAssertion({ code: uniquenessCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: ['apple', ['banana', 'seed'], 'orange', undefined],
        };
        const result = await assertionProvider.run(['grape', 'vine'], mockRunContextWithColumn);
        expect(result.pass).toBe(true);
      });

      it('Uniqueness check with FileReference (comparing URI via modified code)', async () => {
        const uniquenessCodeWithFileRef = `
          if (!context.allOutputs) return { pass: false, message: "allOutputs not provided" };
          let occurrences = 0;
          const getComparable = (val) => {
            if (val && typeof val === 'object' && val.uri && val.blob instanceof Blob) {
              return val.uri;
            }
            return JSON.stringify(val);
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
        const fileRef1Dup = createFileRef('file:///image.png');
        const mockRunContextWithColumn: MockAssertionRunContext = {
          ...baseMockContextWithoutColumnOutputs,
          allOutputsInColumn: [fileRef1, fileRef2, 'some string', fileRef1Dup, ['array', 'item']],
        };
        let result = await assertionProvider.run(fileRef1, mockRunContextWithColumn);
        expect(result.pass).toBe(false);
        expect(result.message).toBe("Value (comparable form: 'file:///image.png') is duplicated (2 times).");
        result = await assertionProvider.run(fileRef2, mockRunContextWithColumn);
        expect(result.pass).toBe(true);
      });
    });

    describe('Handling Empty/Undefined allOutputs (when allOutputsInColumn is provided but empty)', () => {
        const gracefulCode = `
        // This code assumes allOutputs *should* be present (simulating columnAware: true)
        // but handles if it's unexpectedly empty or if logic doesn't strictly need items.
        if (!context.allOutputs) return { pass: false, message: "allOutputs was expected but is undefined/null" };
        if (context.allOutputs.length === 0) {
            return { pass: true, message: "allOutputs is present but empty, handled gracefully." };
        }
        // Potentially other logic if allOutputs has items
        return { pass: true, message: "Handled allOutputs with items." };
        `;

        it('should pass if allOutputsInColumn is an empty array in context', async () => {
        const assertionProvider = createJavascriptAssertion({ code: gracefulCode }, {});
        const mockRunContextWithColumn: MockAssertionRunContext = {
            ...baseMockContextWithoutColumnOutputs,
            allOutputsInColumn: [],
        };
        const result = await assertionProvider.run('some output', mockRunContextWithColumn);
        expect(result.pass).toBe(true);
        expect(result.message).toBe('allOutputs is present but empty, handled gracefully.');
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
        const mockRunContextWithColumn: MockAssertionRunContext = {
            ...baseMockContextWithoutColumnOutputs,
            allOutputsInColumn: ['refA', ['refB_nested'], undefined],
        };
        const result = await assertionProvider.run(['refB_nested'], mockRunContextWithColumn);
        expect(result.pass).toBe(true);
        expect(result.message).toBe('Received 3 total outputs via CodeRef.');
        });
    });
  });
});
