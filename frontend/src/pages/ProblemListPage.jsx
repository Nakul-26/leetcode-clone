
import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Search, Filter, Plus, ChevronRight, Users, CheckCircle2, X, Lock } from 'lucide-react';
import api from '../api';

function ProblemListPage({ user }) {
  const location = useLocation();
  const [problems, setProblems] = useState([]);
  const [successMsg, setSuccessMsg] = useState(location.state?.successMessage || '');
  const [filters, setFilters] = useState({
    search: '',
    difficulty: '',
    tag: ''
  });

  const [apiError, setApiError] = useState(null);

  const canManage = user && (user.role === 'admin' || user.role === 'faculty' || user.role === 'superadmin');
  const isCollegeAdmin = user && (user.role === 'admin' || user.role === 'superadmin');

  useEffect(() => {
    setApiError(null);
    // Ignore a response that arrives after the filters have changed again: requests can finish
    // out of order, and the stale one used to overwrite the newer results.
    let cancelled = false;
    
    // Clean up empty filters to avoid sending 'search='
    const activeFilters = {};
    if (filters.search) activeFilters.search = filters.search;
    if (filters.difficulty) activeFilters.difficulty = filters.difficulty;
    if (filters.tag) activeFilters.tag = filters.tag;

    api.get('/api/v1/problems', { params: activeFilters })
      .then(response => {
        if (!cancelled) setProblems(response.data);
      })
      .catch(error => {
        if (cancelled) return;
        console.error('Error fetching problems:', error);
        setApiError(error.message || 'Unknown error');
      });

    return () => {
      cancelled = true;
    };
  }, [filters]);

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  return (
    <div className="container fade-in">
      {successMsg && (
        <div className="success-box mb-8 flex-between" style={{ padding: '12px 16px', background: 'rgba(var(--success-rgb), 0.1)', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', color: 'var(--success)' }}>
          <div className="flex-center gap-2">
            <CheckCircle2 size={18} />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg('')} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex' }}>
            <X size={18} />
          </button>
        </div>
      )}
      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">Problem Set</h1>
          <p className="text-muted">Master your skills with our curated set of coding challenges.</p>
        </div>
        {canManage && (
          <Link to="/add-problem" className="button">
            <Plus size={18} />
            <span>New Problem</span>
          </Link>
        )}
      </div>

      <div className="responsive-flex mb-8" style={{ background: 'var(--surface)', padding: 'var(--sp-4)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
        <div style={{ flex: 1, position: 'relative', width: '100%' }}>
          <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input 
            type="text" 
            name="search" 
            placeholder="Search problems..." 
            value={filters.search} 
            onChange={handleFilterChange}
            style={{ paddingLeft: '40px', width: '100%' }}
          />
        </div>
        <div style={{ width: '180px' }}>
          <select name="difficulty" value={filters.difficulty} onChange={handleFilterChange} style={{ width: '100%' }}>
            <option value="">All Difficulties</option>
            <option value="Easy">Easy</option>
            <option value="Medium">Medium</option>
            <option value="Hard">Hard</option>
          </select>
        </div>
        <div style={{ width: '180px' }}>
          <input 
            type="text" 
            name="tag" 
            placeholder="Filter by tag..." 
            value={filters.tag} 
            onChange={handleFilterChange}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {apiError && (
        <div className="error-box mb-8 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
          <X size={18} /> {apiError}
        </div>
      )}

      <div className="problem-card-grid">
        {problems.length > 0 ? problems.map(problem => {
          const rate = problem.submissionCount > 0 
            ? ((problem.acceptedCount / problem.submissionCount) * 100).toFixed(1) + '%'
            : '0%';
          if (problem.locked) {
            return (
              <Link
                key={problem._id}
                to={isCollegeAdmin ? "/admin/billing" : "#"}
                className="problem-card"
                style={{ opacity: 0.7, cursor: isCollegeAdmin ? 'pointer' : 'not-allowed' }}
                onClick={(e) => { if (!isCollegeAdmin) e.preventDefault(); }}
                title={isCollegeAdmin ? "Upgrade your plan to unlock this problem" : "Ask your admin to upgrade the plan to unlock this problem"}
              >
                <div className="flex-between mb-2">
                  <span className={`tag difficulty-${problem.difficulty.toLowerCase()}`}>
                    {problem.difficulty}
                  </span>
                  <span className="text-muted flex-center gap-2" style={{ fontSize: '0.8rem', justifyContent: 'flex-end' }}>
                    <Lock size={14} /> Premium
                  </span>
                </div>
                <h3>{problem.title}</h3>
                <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                  {isCollegeAdmin ? 'Upgrade your plan to unlock this problem.' : 'Ask your admin to upgrade the plan to unlock this problem.'}
                </p>
              </Link>
            );
          }

          return (
            <Link key={problem._id} to={`/problems/${problem._id}`} className="problem-card">
              <div className="flex-between mb-2">
                <span className={`tag difficulty-${problem.difficulty.toLowerCase()}`}>
                  {problem.difficulty}
                </span>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                  ID: {problem._id.slice(-6)}
                </span>
              </div>
              <h3>{problem.title}</h3>
              <div className="meta">
                {(problem.tags || []).slice(0, 3).map(tag => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>

              <div className="stats">
                <div style={{ display: 'flex', gap: '12px' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <CheckCircle2 size={14} /> {rate}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Users size={14} /> {problem.submissionCount || 0}
                  </span>
                </div>
                <ChevronRight size={18} />
              </div>
            </Link>
          );
        }) : (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '80px', background: 'var(--surface)', borderRadius: 'var(--radius-xl)', border: '1px dashed var(--border)' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem' }}>No problems found matching your filters.</p>
            <button className="button button-outline mt-4" onClick={() => setFilters({ search: '', difficulty: '', tag: '' })}>Clear all filters</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProblemListPage;
