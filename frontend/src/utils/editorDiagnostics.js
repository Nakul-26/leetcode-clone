// Shows the judge's diagnostics (docs/EDITOR_UX_PLAN.md C1) in the Monaco editor: a red
// underline on each line that has one, with the message and hint on hover, and a way to jump
// to a line from the result panel. Shared by the practice page and the exam workspace.

const OWNER = 'judge';

// The diagnostics in any result shape: a Run response, a submission, or its testResult.
export function diagnosticsOf(result) {
  if (!result || typeof result !== 'object') return [];
  const list = result.diagnostics || result.testResult?.diagnostics;
  return Array.isArray(list) ? list : [];
}

export function applyDiagnosticMarkers(monaco, editor, diagnostics) {
  const model = editor?.getModel?.();
  if (!monaco || !model) return;
  const lineCount = model.getLineCount();
  const markers = (diagnostics || [])
    .filter((d) => Number.isInteger(d.line) && d.line >= 1)
    .map((d) => {
      const line = Math.min(d.line, lineCount);
      const start = d.column || model.getLineFirstNonWhitespaceColumn(line) || 1;
      return {
        severity: monaco.MarkerSeverity.Error,
        startLineNumber: line,
        startColumn: start,
        endLineNumber: line,
        endColumn: Math.max(start + 1, model.getLineMaxColumn(line)),
        message: d.hint ? `${d.message}\n\n${d.hint.replace(/`/g, '')}` : d.message,
        source: 'judge'
      };
    });
  monaco.editor.setModelMarkers(model, OWNER, markers);
}

export function clearDiagnosticMarkers(monaco, editor) {
  const model = editor?.getModel?.();
  if (monaco && model) monaco.editor.setModelMarkers(model, OWNER, []);
}

export function jumpToLine(editor, line, column) {
  if (!editor || !line) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: column || 1 });
  editor.focus();
}
