// What each role is called and can do, for the header badge and the profile page.
export const ROLE_INFO = {
  superadmin: {
    label: 'Super admin',
    color: '#f43f5e',
    can: [
      'Everything an admin can do, across every college',
      'Create colleges and register users of any role',
      'API keys for any college, system banner, backups'
    ]
  },
  admin: {
    label: 'College admin',
    color: '#f59e0b',
    can: [
      'Manage users, assessments, drives and problems in their college',
      'Billing and API keys for their college',
      'System dashboard'
    ]
  },
  faculty: {
    label: 'Faculty',
    color: '#3b82f6',
    can: [
      'Create problems, assessments and drives',
      'Grade written answers and review results',
      'Run interviews'
    ]
  },
  student: {
    label: 'Student',
    color: '#10b981',
    can: [
      'Practice problems and take assigned assessments',
      'Join drives and interviews',
      'See their own submissions'
    ]
  }
};

export const roleInfo = (role) => ROLE_INFO[role] || { label: role || 'Unknown', color: '#64748b', can: [] };
