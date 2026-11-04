import React from 'react';
import { AlertTriangle, Clock, Cpu, Lightbulb, XCircle } from 'lucide-react';

// The short "what went wrong" list at the top of a result (docs/EDITOR_UX_PLAN.md C1): at most
// three entries, each with its line, the compiler's message and a plain-language hint. The raw
// output stays available below it.

const KIND_LABEL = {
  compile: { label: 'Compile error', Icon: XCircle },
  runtime: { label: 'Runtime error', Icon: AlertTriangle },
  timeout: { label: 'Time limit exceeded', Icon: Clock },
  memory: { label: 'Memory limit exceeded', Icon: Cpu }
};

// Hints mark code with backticks; show those parts as code.
function withCode(text) {
  return String(text || '')
    .split(/(`[^`]+`)/g)
    .map((part, i) => (part.startsWith('`') && part.endsWith('`') && part.length > 1
      ? <code key={i} className="diagnostic-code">{part.slice(1, -1)}</code>
      : <React.Fragment key={i}>{part}</React.Fragment>));
}

const DiagnosticsSummary = ({ diagnostics, onJumpToLine }) => {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return null;
  return (
    <div className="diagnostics-summary" data-testid="diagnostics-summary">
      {diagnostics.map((d, i) => {
        const { label, Icon } = KIND_LABEL[d.kind] || KIND_LABEL.runtime;
        const where = d.line ? `Line ${d.line}${d.column ? `, column ${d.column}` : ''}` : null;
        return (
          <div key={i} className="diagnostic">
            <div className="diagnostic-head">
              <Icon size={16} />
              <span className="diagnostic-kind">{label}</span>
              {where && (onJumpToLine ? (
                <button type="button" className="diagnostic-line" onClick={() => onJumpToLine(d.line, d.column)} title="Show this line in the editor">
                  {where}
                </button>
              ) : <span className="diagnostic-line">{where}</span>)}
            </div>
            <div className="diagnostic-message">{d.message}</div>
            {d.hint && (
              <div className="diagnostic-hint">
                <Lightbulb size={14} />
                <span>{withCode(d.hint)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default DiagnosticsSummary;
