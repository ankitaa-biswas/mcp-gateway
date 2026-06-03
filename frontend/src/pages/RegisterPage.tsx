import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Shield, Loader2 } from 'lucide-react';

export function RegisterPage() {
  const [form, setForm] = useState({ tenantName: '', email: '', password: '' });
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: async (credentials: typeof form) => {
      const { data } = await api.post('/auth/register', credentials);
      return data;
    },
    onSuccess: (data) => {
      setAuth(data.token, { id: '', email: form.email, role: 'admin' }, data.tenant);
      toast.success('Tenant registered successfully!');
      navigate('/dashboard');
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error ?? 'Registration failed';
      toast.error(msg);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.tenantName.length < 2) {
      toast.error('Tenant name must be at least 2 characters');
      return;
    }
    if (form.password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    mutation.mutate(form);
  };

  const loading = mutation.isPending;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-brand-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md animate-fade-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600/20 border border-brand-500/30 mb-4">
            <Shield className="w-7 h-7 text-brand-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">Create your workspace</h1>
          <p className="text-gray-500 text-sm mt-1">Set up a new tenant for your organization</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="tenantName" className="label">Organization Name</label>
              <input
                id="tenantName"
                type="text"
                className="input"
                placeholder="Acme Corporation"
                value={form.tenantName}
                onChange={(e) => setForm({ ...form, tenantName: e.target.value })}
                required
                minLength={2}
              />
            </div>
            <div>
              <label htmlFor="reg-email" className="label">Admin Email</label>
              <input
                id="reg-email"
                type="email"
                className="input"
                placeholder="admin@acme.com"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="reg-password" className="label">Password</label>
              <input
                id="reg-password"
                type="password"
                className="input"
                placeholder="Min. 8 characters"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                minLength={8}
              />
            </div>

            <button
              id="register-submit"
              type="submit"
              disabled={loading}
              className="btn-primary w-full justify-center mt-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {loading ? 'Creating workspace…' : 'Create Workspace'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 mt-5">
            Already have an account?{' '}
            <Link to="/login" className="text-brand-400 hover:text-brand-300 font-medium transition-colors">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
