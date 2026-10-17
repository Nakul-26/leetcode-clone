// Every language judge-service-go can execute, in the order shown in language pickers.
// Shared by ProblemPage (practice) and AssessmentWorkspace (exams) so the two pickers
// can't drift out of sync with each other or with judge-service-go's actual support.
export const SUPPORTED_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go', 'ruby', 'php', 'kotlin', 'rust'];
