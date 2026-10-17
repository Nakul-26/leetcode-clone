import React, { useEffect, useState, Suspense, lazy } from 'react';
import { BrowserRouter as Router, Route, Routes, Link, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { Code2, BookOpen, Settings, PlusCircle, LogIn, Database, LogOut, LayoutDashboard, Users, AlertTriangle, CreditCard, Briefcase, CalendarClock } from 'lucide-react';
import ProblemListPage from './pages/ProblemListPage';
import HomePage from './pages/HomePage';
import AssessmentListPage from './pages/AssessmentListPage';
import AssessmentManagementPage from './pages/AssessmentManagementPage';
import AddAssessmentPage from './pages/AddAssessmentPage';
import EditAssessmentPage from './pages/EditAssessmentPage';
import AssessmentDetailsPage from './pages/AssessmentDetailsPage';
import AssessmentPreviewPage from './pages/AssessmentPreviewPage';
import AssessmentWorkspace from './pages/AssessmentWorkspace';
import AssessmentResultPage from './pages/AssessmentResultPage';
import AssessmentResultsPage from './pages/AssessmentResultsPage';
import GradeSubjectivePage from './pages/GradeSubjectivePage';
import DrivesPage from './pages/DrivesPage';
import DriveDetailPage from './pages/DriveDetailPage';
import DriveManagementPage from './pages/DriveManagementPage';
import AddDrivePage from './pages/AddDrivePage';
import EditDrivePage from './pages/EditDrivePage';
import DrivePipelinePage from './pages/DrivePipelinePage';
import MyInterviewsPage from './pages/MyInterviewsPage';
import ExternalInterviewPage from './pages/ExternalInterviewPage';
// Lazy-loaded: pulls in monaco-editor + yjs directly (not via the CDN loader the rest of
// the app's Monaco usage goes through - see InterviewRoom.jsx), which nothing else needs.
const InterviewRoomPage = lazy(() => import('./pages/InterviewRoomPage'));
import QuestionBankPage from './pages/QuestionBankPage';
import AddQuestionPage from './pages/AddQuestionPage';
import EditQuestionPage from './pages/EditQuestionPage';
import AssessmentAttemptDetailPage from './pages/AssessmentAttemptDetailPage';
import ProblemPage from './pages/ProblemPage';
import AddProblemPage from './pages/AddProblemPage';
import EditProblemPage from './pages/EditProblemPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import BillingPage from './pages/BillingPage';
import MySubmissionsPage from './pages/MySubmissionsPage';
import SystemDashboardPage from './pages/SystemDashboardPage';
import UserManagementPage from './pages/UserManagementPage';
import { auth, system } from './api';

function AppContent() {
    const navigate = useNavigate();
    const location = useLocation();
    const [user, setUser] = useState(() => {
        try {
            const raw = localStorage.getItem('user');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    });

    const [banner, setBanner] = useState(null);

    const fetchBanner = async () => {
        try {
            const res = await system.getBanner();
            if (res.data && res.data.active) {
                setBanner(res.data);
            } else {
                setBanner(null);
            }
        } catch (err) {
            console.error("Failed to fetch system banner", err);
        }
    };

    useEffect(() => {
        fetchBanner();
        const interval = setInterval(fetchBanner, 30000);
        window.addEventListener("refresh-banner", fetchBanner);
        return () => {
            clearInterval(interval);
            window.removeEventListener("refresh-banner", fetchBanner);
        };
    }, []);

    useEffect(() => {
        const syncAuth = () => {
            try {
                const raw = localStorage.getItem('user');
                const newUser = raw ? JSON.parse(raw) : null;
                
                // If the user was logged in but now isn't (e.g. token expired), 
                // and we are on a protected route, redirect to login.
                if (user && !newUser) {
                    const protectedRoutes = ['/add-problem', '/my-submissions', '/assessments', '/assessment-attempt', '/admin', '/drives', '/my-interviews', '/interview-room'];
                    if (protectedRoutes.some(path => window.location.pathname.startsWith(path))) {
                        navigate('/login');
                    }
                }
                
                setUser(newUser);
            } catch {
                setUser(null);
            }
        };

        const handleStorage = (e) => {
            if (e.key === 'user' || e.key === 'token' || e.key === null) {
                syncAuth();
            }
        };

        window.addEventListener('auth-change', syncAuth);
        window.addEventListener('storage', handleStorage);

        return () => {
            window.removeEventListener('auth-change', syncAuth);
            window.removeEventListener('storage', handleStorage);
        };
    }, [user, navigate]);

    const handleLogout = async () => {
        // The auth cookie is httpOnly - only the backend can clear it.
        try {
            await auth.logout();
        } catch {
            // Proceed with client-side cleanup regardless - worst case the cookie
            // outlives this session until it naturally expires.
        }
        localStorage.removeItem('user');
        setUser(null);
        window.dispatchEvent(new Event('auth-change'));
        navigate('/login');
    };

    const canCreateProblem = user && (user.role === 'admin' || user.role === 'faculty' || user.role === 'superadmin');
    const isCollegeAdmin = user && (user.role === 'admin' || user.role === 'superadmin');

    const NavLink = ({ to, children, icon: Icon }) => {
        const isActive = location.pathname === to;
        return (
            <Link to={to} className={isActive ? 'active' : ''} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {Icon && <Icon size={18} />}
                <span>{children}</span>
            </Link>
        );
    };

    const isAssessmentRoute = location.pathname.includes('/assessment-attempt/') && !location.pathname.includes('/result');

    useEffect(() => {
        // Global handler to prevent scrolling over number inputs from changing their values
        const handleWheel = () => {
            if (document.activeElement.type === 'number') {
                document.activeElement.blur();
            }
        };
        window.addEventListener('wheel', handleWheel);
        return () => window.removeEventListener('wheel', handleWheel);
    }, []);

    const RequireAuth = ({ children }) => user ? children : <Navigate to="/login" replace />;
    const RequireRole = ({ roles, children }) => user && roles.includes(user.role)
        ? children
        : <Navigate to={user ? "/" : "/login"} replace />;
    const RequireStudent = ({ children }) => <RequireRole roles={['student']}>{children}</RequireRole>;
    const RequireStaff = ({ children }) => <RequireRole roles={['admin', 'faculty', 'superadmin']}>{children}</RequireRole>;

    return (
        <>
            {banner && (
                <div className={`system-incident-banner banner-${banner.type}`} style={{
                    backgroundColor: banner.type === 'error' ? 'var(--error)' : banner.type === 'warning' ? 'var(--warning)' : 'var(--primary)',
                    color: '#fff',
                    padding: '10px 20px',
                    textAlign: 'center',
                    fontWeight: 'bold',
                    fontSize: '0.95rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px',
                    zIndex: 9999,
                    position: 'relative',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    borderBottom: '1px solid rgba(255,255,255,0.1)'
                }}>
                    <AlertTriangle size={18} />
                    <span>{banner.message}</span>
                </div>
            )}
            <div className="header">
                <h1>
                    <Code2 size={28} />
                    <span>Placement Assessment</span>
                </h1>
                {!isAssessmentRoute && (
                <nav>
                    <div className="nav-links">
                        <NavLink to="/problems" icon={BookOpen}>Problems</NavLink>
                        {user && <NavLink to="/assessments" icon={LayoutDashboard}>Assessments</NavLink>}
                        {user && <NavLink to="/drives" icon={Briefcase}>Drives</NavLink>}
                        {user && <NavLink to="/my-interviews" icon={CalendarClock}>My Interviews</NavLink>}
                        {canCreateProblem && (
                            <NavLink to="/admin/assessments" icon={Settings}>Manage</NavLink>
                        )}
                        {canCreateProblem && (
                            <NavLink to="/admin/drives" icon={Briefcase}>Drives Admin</NavLink>
                        )}
                        {canCreateProblem && (
                            <NavLink to="/admin/users" icon={Users}>Users</NavLink>
                        )}
                        {canCreateProblem && (
                            <NavLink to="/admin/system" icon={Database}>System</NavLink>
                        )}
                        {isCollegeAdmin && (
                            <NavLink to="/admin/billing" icon={CreditCard}>Billing</NavLink>
                        )}
                        {canCreateProblem && (
                            <NavLink to="/add-problem" icon={PlusCircle}>Add Problem</NavLink>
                        )}
                        {!user && (
                            <NavLink to="/login" icon={LogIn}>Login</NavLink>
                        )}
                        {user && (
                            <NavLink to="/my-submissions" icon={Code2}>My Submissions</NavLink>
                        )}
                    </div>
                    {user && (
                        <button className="button button-outline logout-btn" onClick={handleLogout} style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
                            <LogOut size={16} />
                            <span>Logout</span>
                        </button>
                    )}
                </nav>
                )}
            </div>
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/problems" element={<ProblemListPage user={user} />} />
                <Route path="/assessments" element={user ? <AssessmentListPage user={user} /> : <Navigate to="/login" replace />} />
                <Route path="/drives" element={<RequireAuth><DrivesPage /></RequireAuth>} />
                <Route path="/drives/:id" element={<RequireAuth><DriveDetailPage /></RequireAuth>} />
                <Route path="/my-interviews" element={<RequireAuth><MyInterviewsPage /></RequireAuth>} />
                <Route path="/interview/:token" element={<ExternalInterviewPage />} />
                <Route path="/interview-room/:slotId" element={<RequireAuth><Suspense fallback={<div className="container">Loading interview room...</div>}><InterviewRoomPage /></Suspense></RequireAuth>} />
                <Route path="/questions" element={<RequireStaff><QuestionBankPage user={user} /></RequireStaff>} />
                <Route path="/questions/add" element={<RequireStaff><AddQuestionPage user={user} /></RequireStaff>} />
                <Route path="/questions/:id/edit" element={<RequireStaff><EditQuestionPage user={user} /></RequireStaff>} />
                <Route path="/assessments/:id" element={<RequireAuth><AssessmentDetailsPage user={user} /></RequireAuth>} />
                <Route path="/assessment-attempt/:attemptId" element={<RequireStudent><AssessmentWorkspace user={user} /></RequireStudent>} />
                <Route path="/assessment-attempt/:attemptId/result" element={<RequireStudent><AssessmentResultPage user={user} /></RequireStudent>} />
                
                {/* Admin/Faculty Routes */}
                <Route path="/admin/assessments" element={<RequireStaff><AssessmentManagementPage /></RequireStaff>} />
                <Route path="/admin/assessments/add" element={<RequireStaff><AddAssessmentPage /></RequireStaff>} />
                <Route path="/admin/assessments/:id/edit" element={<RequireStaff><EditAssessmentPage /></RequireStaff>} />
                <Route path="/admin/assessments/:id/preview" element={<RequireStaff><AssessmentPreviewPage /></RequireStaff>} />
                <Route path="/admin/assessments/:id/results" element={<RequireStaff><AssessmentResultsPage /></RequireStaff>} />
                <Route path="/admin/assessments/:id/grading" element={<RequireStaff><GradeSubjectivePage /></RequireStaff>} />
                <Route path="/admin/assessment-attempt/:attemptId" element={<RequireStaff><AssessmentAttemptDetailPage /></RequireStaff>} />
                <Route path="/admin/drives" element={<RequireStaff><DriveManagementPage /></RequireStaff>} />
                <Route path="/admin/drives/add" element={<RequireStaff><AddDrivePage /></RequireStaff>} />
                <Route path="/admin/drives/:id/edit" element={<RequireStaff><EditDrivePage /></RequireStaff>} />
                <Route path="/admin/drives/:id/pipeline" element={<RequireStaff><DrivePipelinePage /></RequireStaff>} />
                <Route path="/admin/system" element={<RequireStaff><SystemDashboardPage /></RequireStaff>} />
                <Route path="/admin/users" element={<RequireStaff><UserManagementPage /></RequireStaff>} />
                <Route path="/admin/billing" element={<RequireRole roles={['admin', 'superadmin']}><BillingPage user={user} /></RequireRole>} />

                <Route path="/problems/:_id" element={<ProblemPage user={user} />} />
                <Route path="/add-problem" element={<RequireStaff><AddProblemPage /></RequireStaff>} />
                <Route path="/problems/:_id/edit" element={<RequireStaff><EditProblemPage /></RequireStaff>} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/signup" element={<SignupPage />} />
                <Route path="/my-submissions" element={<RequireAuth><MySubmissionsPage /></RequireAuth>} />
            </Routes>
        </>
    );
}

function App() {
    return (
        <Router>
            <AppContent />
        </Router>
    );
}

export default App;
