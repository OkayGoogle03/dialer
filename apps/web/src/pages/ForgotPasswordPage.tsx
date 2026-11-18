import { Link } from 'react-router-dom';

// TODO(Phase 7, depends on: transactional email provider + password_reset_tokens migration):
// POST /api/v1/auth/password-reset/request and /confirm. Until then, admins reset passwords from User Management.
export function ForgotPasswordPage() {
  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>Reset your password</h1>
        <p>Self-service password reset is not available yet. Please ask your company administrator to reset your password.</p>
        <Link to="/login">Back to sign in</Link>
      </div>
    </div>
  );
}
