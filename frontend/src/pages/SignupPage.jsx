import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Code2, AlertCircle, UserPlus } from "lucide-react";
import api from "../api";

// Self-serve signup: creates a brand-new College tenant plus its first user, who is
// always that college's admin. Unlike the old (deleted) RegisterPage.jsx, there is no
// role or collegeId picker here — both are derived server-side, closing the
// privilege-escalation shape that page had.
const SignupPage = () => {
  const navigate = useNavigate();
  const [collegeName, setCollegeName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await api.post("/api/v1/auth/signup", { collegeName, name, email, password });
      const { user } = res.data;
      localStorage.setItem("user", JSON.stringify(user));
      window.dispatchEvent(new Event("auth-change"));
      navigate("/assessments");
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.msg ||
        "Sign up failed. Please try again.";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container fade-in" style={{ minHeight: 'calc(100vh - 100px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="problem-card" style={{ width: '100%', maxWidth: '420px', padding: '48px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

        <div style={{ padding: '16px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '50%', marginBottom: '24px' }}>
          <Code2 size={32} color="var(--primary)" />
        </div>

        <h2 className="text-center mb-2" style={{ fontSize: '1.75rem' }}>Start Your Team</h2>
        <p className="text-center text-muted mb-8" style={{ fontSize: '0.95rem' }}>Set up your college's workspace — you'll be the admin</p>

        {error && (
          <div className="error-box mb-6 w-100 flex-center gap-2" style={{ justifyContent: 'flex-start', width: '100%' }}>
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ width: '100%' }}>
          <div className="form-group mb-4">
            <label style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>College Name</label>
            <input
              type="text"
              value={collegeName}
              onChange={(e) => setCollegeName(e.target.value)}
              placeholder="Acme Institute of Technology"
              required
              style={{ padding: '14px 16px', fontSize: '1rem' }}
            />
          </div>
          <div className="form-group mb-4">
            <label style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              required
              autoComplete="name"
              style={{ padding: '14px 16px', fontSize: '1rem' }}
            />
          </div>
          <div className="form-group mb-4">
            <label style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email Address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              required
              autoComplete="email"
              style={{ padding: '14px 16px', fontSize: '1rem' }}
            />
          </div>
          <div className="form-group mb-8">
            <label style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete="new-password"
              style={{ padding: '14px 16px', fontSize: '1rem' }}
            />
          </div>

          <button type="submit" className="button" style={{ width: '100%', padding: '16px', fontSize: '1.05rem', borderRadius: '100px' }} disabled={isLoading}>
            {isLoading ? 'Creating your workspace...' : (
              <>
                <UserPlus size={20} />
                Create Workspace
              </>
            )}
          </button>
        </form>

        <div className="text-center mt-8 pt-6 w-100" style={{ width: '100%', borderTop: '1px solid var(--border)' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Already have an account?{" "}
            <Link to="/login" style={{ color: 'var(--primary)', fontWeight: '600' }}>
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;
