'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Role, TeamUser } from '@/lib/types';

const ROLES: Role[] = ['customer', 'staff', 'admin'];

export default function UserManagement({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers((await api.adminUsers()).users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function changeRole(user: TeamUser, role: Role) {
    if (role === user.role) return;
    setSavingId(user.id);
    setError(null);
    try {
      const { user: updated } = await api.adminSetRole(user.id, role);
      setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the role.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className="card" aria-labelledby="users-title">
      <div className="card-head">
        <div>
          <h2 id="users-title">Users and roles</h2>
          <p className="muted small">
            Customers manage their own bookings. Staff see and cancel every booking. Admins also manage roles.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {loading && <div className="skeleton-list" aria-busy="true"><div className="skeleton" /><div className="skeleton" /></div>}

      {!loading && users.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.fullName}{u.id === currentUserId && <span className="muted small"> (you)</span>}</td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select
                      className="role-select"
                      aria-label={`Role for ${u.fullName}`}
                      value={u.role}
                      disabled={u.id === currentUserId || savingId === u.id}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
