// Shared Monaco theme + editor options for both the practice IDE (ProblemPage) and the
// exam workspace (AssessmentWorkspace) — kept identical between the two on purpose so the
// editing experience doesn't subtly differ between practice and graded attempts.

export function defineModernDarkTheme(monaco) {
  monaco.editor.defineTheme('modern-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editor.lineHighlightBackground': '#161b22',
      'editorLineNumber.foreground': '#484f58',
      'editorIndentGuide.background': '#21262d',
    }
  });
}

export const MONACO_EDITOR_OPTIONS = {
  fontSize: 15,
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 20, bottom: 20 },
  renderLineHighlight: 'all',
  mouseWheelZoom: false,
  mouseWheelScrollSensitivity: 1,
  scrollbar: {
    vertical: 'visible',
    horizontal: 'visible',
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    alwaysConsumeMouseWheel: false
  }
};
