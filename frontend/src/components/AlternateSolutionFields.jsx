import { DEFAULT_ALTERNATE_LANGUAGE } from '../utils/problemForm';

// The optional second solution (JUDGE_FIX_PLAN P11), shared by the add and edit problem pages.
// When it is filled in, generating and saving also run it on every test input, and the problem
// cannot be saved where it disagrees with the reference solution.
const AlternateSolutionFields = ({ formData, onChange }) => (
  <details className="mb-8" open={!!String(formData.alternateSolution || '').trim()}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Second solution (optional)</summary>
    <p className="form-hint mt-2 mb-4">
      A second, independent solution, such as a simple brute force, ideally in another language. Every test is run
      through both and the problem cannot be saved where they disagree, so one wrong reference solution cannot
      set wrong expected outputs. It gets 3x the time limit; where it runs out of time the test is only skipped.
      Students never see it.
    </p>
    <div className="form-group mb-4">
      <label>Second Solution Language</label>
      <select name="alternateSolutionLanguage" value={formData.alternateSolutionLanguage || DEFAULT_ALTERNATE_LANGUAGE} onChange={onChange}>
        <option value="javascript">JavaScript</option>
        <option value="typescript">TypeScript</option>
        <option value="python">Python</option>
        <option value="java">Java</option>
        <option value="go">Go</option>
        <option value="cpp">C++</option>
        <option value="c">C</option>
        <option value="csharp">C#</option>
      </select>
    </div>
    <div className="form-group">
      <label>Second Solution Code</label>
      <textarea
        name="alternateSolution"
        value={formData.alternateSolution || ''}
        onChange={onChange}
        placeholder="Optional: a brute-force solution to cross-check the reference solution..."
        style={{ height: '160px', fontFamily: "'JetBrains Mono', monospace" }}
        data-testid="alternate-solution"
      />
    </div>
  </details>
);

export default AlternateSolutionFields;
