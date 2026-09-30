'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const { user, login, signup } = useAuth();
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isSignup = mode === 'signup';

  useEffect(() => {
    if (user) router.replace('/dashboard');
  }, [user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      if (isSignup) await signup({ fullName, email, password });
      else await login(email, password);
      router.replace('/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.details?.length) {
          setFieldErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
        }
        setError(err.code === 'VALIDATION_ERROR' ? 'Please fix the highlighted fields.' : err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="center-screen">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden>
          BS
        </div>
        <h1>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p className="muted">
          {isSignup ? 'Sign up to book appointments with our assistant.' : 'Log in to manage your appointments.'}
        </p>

        <form onSubmit={onSubmit} noValidate>
          {isSignup && (
            <div className="field">
              <label htmlFor="fullName">Full name</label>
              <input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
              {fieldErrors.fullName && <span className="field-error">{fieldErrors.fullName}</span>}
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              required
            />
            {fieldErrors.password && <span className="field-error">{fieldErrors.password}</span>}
            {isSignup && !fieldErrors.password && <span className="hint">At least 8 characters.</span>}
          </div>

          {error && <div className="alert alert-error" role="alert">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? 'Please wait...' : isSignup ? 'Sign up' : 'Log in'}
          </button>
        </form>

        <p className="auth-switch">
          {isSignup ? (
            <>Already have an account? <Link href="/login">Log in</Link></>
          ) : (
            <>New here? <Link href="/signup">Create an account</Link></>
          )}
        </p>
      </div>
    </main>
  );
}
