import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import {
  LayoutDashboard,
  Server,
  Building2,
  ScrollText,
  LogOut,
  Shield,
  ShieldAlert,
  Key,
  ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';

const navItems = [
  { to: '/dashboard',   label: 'Overview',    icon: LayoutDashboard },
  { to: '/servers',     label: 'MCP Servers', icon: Server },
  { to: '/credentials', label: 'My Credentials', icon: Key },
  { to: '/tenants',     label: 'Tenants',     icon: Building2 },
  { to: '/audit-logs',  label: 'Audit Logs',  icon: ScrollText },
];

export function DashboardLayout() {
  const { user, tenant, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 flex flex-col bg-gray-900 border-r border-gray-800">
        {/* Logo */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-gray-800">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-brand-600/20 border border-brand-500/30">
            <Shield className="w-5 h-5 text-brand-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">MCP Gateway</p>
            <p className="text-xs text-gray-500">Enterprise</p>
          </div>
        </div>

        {/* Tenant badge */}
        <div className="px-4 py-3 mx-3 mt-4 rounded-lg bg-gray-800/60 border border-gray-700/50">
          <p className="text-xs text-gray-500 mb-0.5">Active Tenant</p>
          <p className="text-sm font-medium text-gray-200 truncate">{tenant?.name ?? '—'}</p>
          <span className="badge badge-blue mt-1">{tenant?.slug}</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-brand-600/20 text-brand-300 border border-brand-500/20'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800',
                )
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
              <ChevronRight className="w-3 h-3 ml-auto opacity-40" />
              <ChevronRight className="w-3 h-3 ml-auto opacity-40" />
            </NavLink>
          ))}
          {user?.role === 'admin' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-red-900/20 text-red-400 border border-red-500/20'
                    : 'text-gray-400 hover:text-red-400 hover:bg-gray-800'
                )
              }
            >
              <ShieldAlert className="w-4 h-4 flex-shrink-0" />
              Admin Panel
              <ChevronRight className="w-3 h-3 ml-auto opacity-40" />
            </NavLink>
          )}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Topbar */}
        <header className="h-16 flex items-center justify-end px-8 bg-gray-900 border-b border-gray-800">
          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <p className="text-sm font-medium text-gray-200">{user?.email}</p>
              <p className="text-xs text-gray-500 capitalize">{user?.role}</p>
            </div>
            <div className="w-9 h-9 rounded-full bg-brand-600/20 border border-brand-500/30 flex items-center justify-center text-brand-400 font-semibold">
              {user?.email?.[0]?.toUpperCase()}
            </div>
            <button
              onClick={handleLogout}
              title="Logout"
              className="ml-2 p-2 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 animate-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
