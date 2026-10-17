import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Users, Upload, CheckCircle, AlertCircle, Trash2, UserPlus, FileText, Download, Search, Key, Shield, User as UserIcon, Filter, FileSpreadsheet } from 'lucide-react';
import { readWorkbookRows, downloadAoaAsExcel, downloadRowsAsExcel } from '../utils/excel';
import { admin } from '../api';

const NEW_USER_DEFAULTS = { name: '', email: '', password: '', role: 'student', usn: '', section: '' };

const UserManagementPage = () => {
  const [activeTab, setActiveTab] = useState('list'); // 'list' or 'bulk'
  const [usersJson, setUsersJson] = useState('');
  const [defaultPassword, setDefaultPassword] = useState('Student@2026');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  // List users state
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Add-single-user modal state
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState(NEW_USER_DEFAULTS);
  const [addUserError, setAddUserError] = useState(null);
  const [addUserResult, setAddUserResult] = useState(null);
  const [addingUser, setAddingUser] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await admin.listUsers({ search, role: roleFilter, page });
      setUsers(res.data.users);
      setTotalPages(res.data.totalPages);
    } catch (err) {
      console.error(err);
      setError('Failed to fetch users');
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter, page]);

  useEffect(() => {
    if (activeTab === 'list') {
      fetchUsers();
    }
  }, [activeTab, fetchUsers]);

  const [previewUsers, setPreviewUsers] = useState([]);

  const processAndValidateUsers = (rawUsers) => {
    const seenEmails = new Set();
    const seenUsns = new Set();

    return rawUsers.map((u, i) => {
      const name = (u.name || '').trim();
      const email = (u.email || '').trim().toLowerCase();
      const usn = (u.usn || '').trim();
      const section = (u.section || '').trim();

      const validationErrors = [];
      if (!name) validationErrors.push('Missing name');
      if (!email) {
        validationErrors.push('Missing email');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        validationErrors.push('Invalid email format');
      }

      if (email && seenEmails.has(email)) {
        validationErrors.push('Duplicate email in batch');
      }
      if (email) seenEmails.add(email);

      if (usn) {
        if (seenUsns.has(usn)) {
          validationErrors.push('Duplicate USN in batch');
        }
        seenUsns.add(usn);
      }

      return {
        rowNum: u.rowNum || (i + 1),
        name,
        email,
        usn,
        section,
        errors: validationErrors,
        isValid: validationErrors.length === 0
      };
    });
  };

  useEffect(() => {
    if (!usersJson.trim()) {
      setPreviewUsers([]);
      return;
    }
    try {
      let parsed = [];
      try {
        parsed = JSON.parse(usersJson);
      } catch {
        // Try parsing as CSV-like lines: USN, Name, Email, Section
        const lines = usersJson.split('\n').filter(line => line.trim());
        parsed = lines.map((line) => {
          const parts = line.split(',').map(p => p.trim());
          if (parts.length >= 2) {
            return {
              usn: parts[0] || '',
              name: parts[1] || '',
              email: parts[2] || '',
              section: parts[3] || ''
            };
          }
          return null;
        }).filter(Boolean);
      }

      if (Array.isArray(parsed)) {
        const validated = processAndValidateUsers(parsed);
        setPreviewUsers(validated);
      }
    } catch {
      setPreviewUsers([]);
    }
  }, [usersJson]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const rawJson = await readWorkbookRows(evt.target.result);

        const mapped = rawJson.map((row, idx) => {
          const rowKeys = Object.keys(row);
          const getVal = (possibleHeaders) => {
            const match = rowKeys.find(k => possibleHeaders.includes(k.toLowerCase().trim()));
            return match ? String(row[match]).trim() : '';
          };

          return {
            rowNum: idx + 2,
            usn: getVal(['usn', 'roll number', 'usn/roll', 'id', 'rollno', 'student usn']),
            name: getVal(['name', 'student name', 'full name', 'studentname']),
            email: getVal(['email', 'email id', 'emailaddress', 'email address']),
            section: getVal(['section', 'sec', 'class'])
          };
        });

        if (mapped.length === 0) {
          throw new Error('No data rows found in the sheet. Please make sure the headers are USN, Name, Email, Section.');
        }

        const validated = processAndValidateUsers(mapped);
        setPreviewUsers(validated);
        setUsersJson(JSON.stringify(mapped.map(({ usn, name, email, section }) => ({ usn, name, email, section })), null, 2));
        setError(null);
      } catch (err) {
        console.error(err);
        setError('Failed to parse file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleBulkImport = async (e) => {
    e.preventDefault();
    if (previewUsers.length === 0) {
      setError('No student records loaded to import');
      return;
    }

    const invalidUsersCount = previewUsers.filter(u => !u.isValid).length;
    if (invalidUsersCount > 0) {
      if (!window.confirm(`There are ${invalidUsersCount} rows with errors. They will be skipped. Proceed with importing valid users?`)) {
        return;
      }
    }

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const validUsersToImport = previewUsers
        .filter(u => u.isValid)
        .map(({ name, email, usn, section }) => ({ name, email, usn, section }));

      if (validUsersToImport.length === 0) {
        throw new Error('No valid student records found to import');
      }

      const res = await admin.bulkImportStudents({
        users: validUsersToImport,
        defaultPassword
      });

      setResults(res.data);
      setUsersJson('');
      setPreviewUsers([]);
      // Reload current users page
      fetchUsers();
    } catch (err) {
      console.error('Import failed', err);
      setError(err.response?.data?.error || err.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (userId, userName) => {
    const newPass = prompt(`Enter new password for ${userName}:`, 'Student@2026');
    if (!newPass) return;

    try {
      await admin.resetPassword(userId, newPass);
      alert('Password reset successfully');
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || 'Failed to reset password');
    }
  };

  const handleDeleteUser = async (userId, userName) => {
    if (!window.confirm(`Remove ${userName}? This frees their seat and cannot be undone.`)) return;

    try {
      await admin.deleteUser(userId);
      fetchUsers();
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || 'Failed to remove user');
    }
  };

  const openAddUser = () => {
    setNewUser(NEW_USER_DEFAULTS);
    setAddUserError(null);
    setAddUserResult(null);
    setShowAddUser(true);
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setAddingUser(true);
    setAddUserError(null);
    try {
      const res = await admin.createUser(newUser);
      setAddUserResult(res.data);
      fetchUsers();
    } catch (err) {
      console.error(err);
      setAddUserError(err.response?.data?.error || err.response?.data?.message || 'Failed to create user');
    } finally {
      setAddingUser(false);
    }
  };

  const downloadSample = () => {
    const sampleData = [
      ["USN", "Name", "Email", "Section"],
      ["1BY23CS001", "John Doe", "john@college.edu", "A"],
      ["1BY23CS002", "Jane Smith", "jane@college.edu", "A"]
    ];
    downloadAoaAsExcel("student_import_template.xlsx", "Students", sampleData);
  };

  const downloadCredentials = () => {
    if (!results || !results.created || results.created.length === 0) return;

    const data = results.created.map(u => ({
      USN: u.usn || '',
      Name: u.name || '',
      Email: u.email || '',
      Section: u.section || '',
      Password: u.password || ''
    }));

    downloadRowsAsExcel("student_credentials.xlsx", "Credentials", data);
  };

  const exportAllUsers = () => {
    const data = users.map(u => ({
      ID: u.id,
      Name: u.name,
      USN: u.usn || '',
      Email: u.email,
      Section: u.section || '',
      Role: u.role
    }));
    downloadRowsAsExcel("platform_users.xlsx", "Users", data);
  };

  return (
    <div className="container fade-in">
      <div className="flex-between mb-8">
        <div>
          <h1 className="mb-2">User Management</h1>
          <p className="text-muted">Manage platform access and onboard students.</p>
        </div>
        <div className="flex-center gap-3">
          <button
            className={`button ${activeTab === 'list' ? 'button-primary' : 'button-outline'}`}
            onClick={() => setActiveTab('list')}
          >
            <Users size={18} /> User List
          </button>
          <button
            className={`button ${activeTab === 'bulk' ? 'button-primary' : 'button-outline'}`}
            onClick={() => { setActiveTab('bulk'); setResults(null); }}
          >
            <Upload size={18} /> Bulk Import
          </button>
          <button className="button button-primary" onClick={openAddUser}>
            <UserPlus size={18} /> Add User
          </button>
        </div>
      </div>

      {activeTab === 'list' && (
        <div className="fade-in">
          {/* Filters */}
          <div className="responsive-flex mb-6" style={{ background: 'var(--surface)', padding: '16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                placeholder="Search by name, email, or USN..." 
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                style={{ paddingLeft: '40px', background: 'var(--bg)', width: '100%' }}
              />
            </div>
            <div className="flex-center gap-3">
              <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }} style={{ width: '180px', background: 'var(--bg)' }}>
                <option value="">All Roles</option>
                <option value="student">Student</option>
                <option value="faculty">Faculty</option>
                <option value="admin">Admin</option>
              </select>
              <button className="button button-outline" onClick={exportAllUsers}>
                <Download size={16} /> Export Excel
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Name & Email</th>
                  <th>USN</th>
                  <th>Section</th>
                  <th>Role</th>
                  <th>ID</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div style={{ fontWeight: '600' }}>{user.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{user.email}</div>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontWeight: '500' }}>{user.usn || '-'}</td>
                    <td>{user.section || '-'}</td>
                    <td>
                      <span className={`tag ${user.role === 'admin' ? 'difficulty-hard' : (user.role === 'faculty' ? 'difficulty-medium' : '')}`} style={{ textTransform: 'uppercase', fontSize: '0.7rem' }}>
                        {user.role}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{user.id}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="flex-center gap-2" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="button button-outline"
                          onClick={() => handleResetPassword(user.id, user.name)}
                          style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                        >
                          <Key size={14} /> Reset Password
                        </button>
                        <button
                          className="button button-outline"
                          onClick={() => handleDeleteUser(user.id, user.name)}
                          style={{ padding: '6px 12px', fontSize: '0.8rem', color: 'var(--error)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
                        >
                          <Trash2 size={14} /> Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loading && (
                  <tr>
                    <td colSpan="6" style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex-center gap-4 mt-8">
              <button 
                className="button button-outline" 
                disabled={page === 1} 
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span className="text-muted">Page {page} of {totalPages}</span>
              <button 
                className="button button-outline" 
                disabled={page === totalPages} 
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'bulk' && (
        <div className="grid-2-col fade-in" style={{ gridTemplateColumns: previewUsers.length > 0 || results ? '1fr' : '1fr 1fr' }}>
          {/* Left panel: Upload and Input forms */}
          {!results && (
            <div className="problem-card">
              <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                <UserPlus size={22} color="var(--primary)" /> Import Students
              </h3>

              <div className="mb-8 p-8" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-lg)', border: '2px dashed var(--border)', textAlign: 'center' }}>
                <FileSpreadsheet size={48} className="text-muted mb-4" style={{ margin: '0 auto' }} />
                <h4 className="mb-2">Upload Student Sheet</h4>
                <p className="text-muted mb-6" style={{ fontSize: '0.9rem' }}>Upload .xlsx, .xls, or .csv containing USN, Name, Email, Section</p>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileUpload} 
                  accept=".xlsx, .xls, .csv" 
                  style={{ display: 'none' }} 
                />
                <button 
                  type="button" 
                  className="button button-primary" 
                  onClick={() => fileInputRef.current.click()}
                >
                  <Upload size={18} /> Select Excel/CSV
                </button>
              </div>
              
              <form onSubmit={handleBulkImport}>
                <div className="form-group mb-6">
                  <label className="label">Default Password for All</label>
                  <input 
                    type="text" 
                    className="input" 
                    value={defaultPassword}
                    onChange={(e) => setDefaultPassword(e.target.value)}
                    placeholder="e.g. Student@2026"
                    required
                  />
                  <p className="form-hint">
                    Initial login password. Leave blank if random password auto-generation per student is preferred.
                  </p>
                </div>

                <div className="form-group mb-6">
                  <div className="flex-between mb-2">
                    <label className="label" style={{ margin: 0 }}>Review or Paste CSV Data (USN,Name,Email,Section)</label>
                    <button type="button" onClick={downloadSample} style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Download size={14} /> Download Template
                    </button>
                  </div>
                  <textarea 
                    className="input" 
                    style={{ minHeight: '150px', fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)', fontSize: '0.9rem', lineHeight: '1.5' }}
                    value={usersJson}
                    onChange={(e) => setUsersJson(e.target.value)}
                    placeholder={`PASTE JSON OR CSV:
USN,Name,Email,Section
1BY23CS001,John Doe,john@college.edu,A
1BY23CS002,Jane Smith,jane@college.edu,B`}
                  />
                </div>

                {error && (
                  <div className="error-box mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                    <AlertCircle size={18} /> {error}
                  </div>
                )}

                {previewUsers.length > 0 && (
                  <button type="submit" className="button button-primary w-full" disabled={loading} style={{ height: '48px', fontSize: '1rem' }}>
                    {loading ? 'Processing Import...' : `Onboard ${previewUsers.filter(u => u.isValid).length} Valid Students`}
                  </button>
                )}
              </form>
            </div>
          )}

          {/* Right panel: Preview or Results */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {!results && previewUsers.length === 0 && (
              <div className="problem-card">
                <h4 className="mb-4">Onboarding Instructions</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="flex-center gap-3" style={{ justifyContent: 'flex-start' }}>
                    <div style={{ background: 'var(--primary-glow)', color: 'var(--primary)', width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '0.9rem' }}>1</div>
                    <p className="text-secondary" style={{ fontSize: '0.9rem', margin: 0 }}>Upload an Excel file or paste a student list with column headers.</p>
                  </div>
                  <div className="flex-center gap-3" style={{ justifyContent: 'flex-start' }}>
                    <div style={{ background: 'var(--primary-glow)', color: 'var(--primary)', width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '0.9rem' }}>2</div>
                    <p className="text-secondary" style={{ fontSize: '0.9rem', margin: 0 }}>The system will parse columns: USN (optional), Name, Email, and Section (optional).</p>
                  </div>
                  <div className="flex-center gap-3" style={{ justifyContent: 'flex-start' }}>
                    <div style={{ background: 'var(--primary-glow)', color: 'var(--primary)', width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '0.9rem' }}>3</div>
                    <p className="text-secondary" style={{ fontSize: '0.9rem', margin: 0 }}>Verify data sanity, identify duplicates instantly in the interactive preview grid, and click Onboard.</p>
                  </div>
                </div>
              </div>
            )}

            {!results && previewUsers.length > 0 && (
              <div className="problem-card fade-in">
                <div className="flex-between mb-4">
                  <h4 style={{ margin: 0 }}>Import Preview ({previewUsers.length} Students Detected)</h4>
                  <div className="flex-center gap-2">
                    <span className="tag status-success" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', border: 'none' }}>
                      {previewUsers.filter(u => u.isValid).length} Valid
                    </span>
                    {previewUsers.filter(u => !u.isValid).length > 0 && (
                      <span className="tag status-error" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: 'none' }}>
                        {previewUsers.filter(u => !u.isValid).length} Errors
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ maxHeight: '350px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  <table className="table" style={{ margin: 0 }}>
                    <thead>
                      <tr>
                        <th>USN</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>Section</th>
                        <th style={{ textAlign: 'right' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewUsers.map((u, i) => (
                        <tr key={i} style={{ opacity: u.isValid ? 1 : 0.7 }}>
                          <td style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{u.usn || '-'}</td>
                          <td style={{ fontWeight: '500' }}>{u.name || <span className="text-muted" style={{ fontStyle: 'italic' }}>empty</span>}</td>
                          <td style={{ fontSize: '0.85rem' }}>{u.email || <span className="text-muted" style={{ fontStyle: 'italic' }}>empty</span>}</td>
                          <td>{u.section || '-'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {u.isValid ? (
                              <span style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: '600' }}>Ready</span>
                            ) : (
                              <span style={{ color: 'var(--error)', fontSize: '0.8rem', fontWeight: '600' }}>
                                {u.errors[0]}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {results && (
              <div className="problem-card fade-in" style={{ borderColor: 'var(--success)', background: 'rgba(16, 185, 129, 0.01)' }}>
                <h3 className="mb-6 flex-center gap-2" style={{ justifyContent: 'flex-start', color: 'var(--success)' }}>
                  <CheckCircle size={24} /> Import Complete
                </h3>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                  <div style={{ background: 'var(--surface)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.25rem', fontWeight: '800', color: 'var(--success)' }}>{results.count}</div>
                    <div className="text-muted" style={{ fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.05em', marginTop: '4px' }}>Created Accounts</div>
                  </div>
                  <div style={{ background: 'var(--surface)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', textAlign: 'center' }}>
                    <div style={{ fontSize: '2.25rem', fontWeight: '800', color: results.errors.length > 0 ? 'var(--error)' : 'var(--text-muted)' }}>{results.errors.length}</div>
                    <div className="text-muted" style={{ fontSize: '0.75rem', textTransform: 'uppercase', fontWeight: '700', letterSpacing: '0.05em', marginTop: '4px' }}>Failed/Skipped</div>
                  </div>
                </div>

                <div className="flex-center gap-3 mb-8">
                  {results.created.length > 0 && (
                    <button className="button button-primary" onClick={downloadCredentials} style={{ flex: 1, height: '44px' }}>
                      <Download size={16} /> Download Credentials CSV
                    </button>
                  )}
                  <button className="button button-outline" onClick={() => setResults(null)} style={{ flex: 1, height: '44px' }}>
                    Done
                  </button>
                </div>

                {results.errors.length > 0 && (
                  <div>
                    <h4 className="mb-3 text-muted" style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Details on skipped rows:</h4>
                    <div style={{ maxHeight: '200px', overflowY: 'auto', background: 'var(--bg)', padding: '16px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                      {results.errors.map((err, i) => (
                        <div key={i} className="mb-2 pb-2 flex-between" style={{ fontSize: '0.85rem', borderBottom: i < results.errors.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <div>
                            <span style={{ color: 'var(--text-muted)', marginRight: '8px' }}>Row {err.row || i+1}:</span>
                            <span style={{ fontWeight: '600' }}>{err.email || err.usn || 'Unknown'}</span>
                          </div>
                          <span className="tag" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: 'none', fontSize: '0.8rem' }}>
                            {err.error}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      
      {showAddUser && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="problem-card" style={{ width: '480px', maxHeight: '85vh', overflowY: 'auto', padding: '24px' }}>
            <h3 className="mb-4">Add User</h3>

            {addUserResult ? (
              <div>
                <div className="error-box mb-4" style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', borderColor: 'rgba(16, 185, 129, 0.2)' }}>
                  {addUserResult.user.name} created successfully.
                </div>
                <div className="form-group mb-4">
                  <label className="label">Password (shown once)</label>
                  <input type="text" className="input" readOnly value={addUserResult.password} onFocus={(e) => e.target.select()} />
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button className="button" onClick={() => setShowAddUser(false)}>Done</button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAddUser}>
                {addUserError && (
                  <div className="error-box mb-4 flex-center gap-2" style={{ justifyContent: 'flex-start' }}>
                    <AlertCircle size={18} /> {addUserError}
                  </div>
                )}

                <div className="form-group mb-4">
                  <label className="label">Name</label>
                  <input type="text" className="input" required value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
                </div>
                <div className="form-group mb-4">
                  <label className="label">Email</label>
                  <input type="email" className="input" required value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
                </div>
                <div className="form-group mb-4">
                  <label className="label">Role</label>
                  <select className="input" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                    <option value="student">Student</option>
                    <option value="faculty">Faculty</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="form-group mb-4">
                  <label className="label">USN (optional)</label>
                  <input type="text" className="input" value={newUser.usn} onChange={(e) => setNewUser({ ...newUser, usn: e.target.value })} />
                </div>
                <div className="form-group mb-4">
                  <label className="label">Section (optional)</label>
                  <input type="text" className="input" value={newUser.section} onChange={(e) => setNewUser({ ...newUser, section: e.target.value })} />
                </div>
                <div className="form-group mb-6">
                  <label className="label">Password (optional — leave blank to auto-generate)</label>
                  <input type="text" className="input" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
                </div>

                <div className="flex-center gap-3">
                  <button type="button" className="button button-outline" style={{ flex: 1 }} onClick={() => setShowAddUser(false)}>Cancel</button>
                  <button type="submit" className="button button-primary" style={{ flex: 1 }} disabled={addingUser}>
                    {addingUser ? 'Creating...' : 'Create User'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      <style>{`
        .w-full { width: 100%; }
        .label { display: block; margin-bottom: 8px; font-weight: 500; color: var(--text-secondary); font-size: 0.95rem; }
        .input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--text); padding: 12px 16px; }
        .input:focus { border-color: var(--primary); outline: none; }
      `}</style>
    </div>
  );
};

export default UserManagementPage;
