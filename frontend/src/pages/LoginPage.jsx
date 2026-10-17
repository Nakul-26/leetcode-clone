import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Code2, AlertCircle, LogIn } from "lucide-react";
import api from "../api";

const LoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await api.post("/api/v1/auth/login", { email, password });
      const { user } = res.data;
      localStorage.setItem("user", JSON.stringify(user));
      window.dispatchEvent(new Event("auth-change"));
      navigate("/assessments");
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        err.response?.data?.msg ||
        "Login failed. Please check your credentials.";
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
        
        <h2 className="text-center mb-2" style={{ fontSize: '1.75rem' }}>Welcome Back</h2>
        <p className="text-center text-muted mb-8" style={{ fontSize: '0.95rem' }}>Enter your credentials to access your account</p>
        
        {error && (
          <div className="error-box mb-6 w-100 flex-center gap-2" style={{ justifyContent: 'flex-start', width: '100%' }}>
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        
        <form onSubmit={handleSubmit} style={{ width: '100%' }}>
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
              autoComplete="current-password"
              style={{ padding: '14px 16px', fontSize: '1rem' }}
            />
          </div>
          
          <button type="submit" className="button" style={{ width: '100%', padding: '16px', fontSize: '1.05rem', borderRadius: '100px' }} disabled={isLoading}>
            {isLoading ? 'Signing in...' : (
              <>
                <LogIn size={20} />
                Sign In
              </>
            )}
          </button>
        </form>
        
        <div className="text-center mt-8 pt-6 w-100" style={{ width: '100%', borderTop: '1px solid var(--border)' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6' }}>
            <strong>Accounts are provided by your department.</strong><br />
            If you cannot log in or forgot your password,<br />
            <span style={{ color: 'var(--primary)', fontWeight: '600' }}>
              contact your faculty or administrator.
            </span>
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '16px' }}>
            New college?{" "}
            <Link to="/signup" style={{ color: 'var(--primary)', fontWeight: '600' }}>
              Create a workspace
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
