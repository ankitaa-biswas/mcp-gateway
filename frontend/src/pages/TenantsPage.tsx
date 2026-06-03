import { useAuthStore } from '@/store/authStore';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { Building2, Calendar, ShieldCheck, Users } from 'lucide-react';

interface TenantDetails {
  id: string;
  name: string;
  slug: string;
  plan: string;
  is_active: number;
  created_at: string;
}

const planBadge: Record<string, string> = {
  free: 'badge-blue',
  pro: 'badge-green',
  enterprise: 'badge-yellow',
};

export function TenantsPage() {
  const { tenant: authTenant } = useAuthStore();

  const { data: tenant, isLoading: loading } = useQuery<TenantDetails>({
    queryKey: ['tenant', 'me'],
    queryFn: async () => {
      const { data } = await api.get('/tenants/me');
      return data;
    },
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-600">
        Loading tenant info…
      </div>
    );
  }

  if (!tenant) {
    return <p className="text-gray-500">Could not load tenant information.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Tenant</h1>
        <p className="text-gray-500 text-sm mt-1">Your organization's workspace details</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main info card */}
        <div className="lg:col-span-2 card space-y-5">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-brand-600/10 border border-brand-500/20">
              <Building2 className="w-6 h-6 text-brand-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">{tenant.name}</h2>
              <code className="text-xs text-gray-500 font-mono bg-gray-800 px-2 py-0.5 rounded mt-1 inline-block">
                /{tenant.slug}
              </code>
            </div>
            <div className="ml-auto">
              <span className={`badge ${tenant.is_active ? 'badge-green' : 'badge-red'}`}>
                {tenant.is_active ? 'Active' : 'Suspended'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-800">
            <div>
              <p className="text-xs text-gray-500 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Plan
              </p>
              <span className={`badge ${planBadge[tenant.plan] ?? 'badge-blue'}`}>
                {tenant.plan.toUpperCase()}
              </span>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5" /> Created
              </p>
              <p className="text-sm text-gray-300">
                {new Date(tenant.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-gray-500 mb-1">Tenant ID</p>
              <code className="text-xs text-gray-400 font-mono">{tenant.id}</code>
            </div>
          </div>
        </div>

        {/* Side info */}
        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-3">
              <Users className="w-4 h-4 text-brand-400" />
              Current User
            </div>
            <p className="text-sm text-gray-400">{authTenant?.name}</p>
            <p className="text-xs text-gray-600 mt-1">slug: {authTenant?.slug}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
