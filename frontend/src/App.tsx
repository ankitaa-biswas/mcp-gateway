import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { LoginPage } from '@/pages/LoginPage';
import { RegisterPage } from '@/pages/RegisterPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { ServersPage } from '@/pages/ServersPage';
import { ServerDetailPage } from '@/pages/ServerDetailPage';
import { TenantsPage } from '@/pages/TenantsPage';
import { AuditLogsPage } from '@/pages/AuditLogsPage';
import { CredentialsPage } from '@/pages/CredentialsPage';
import { AdminPage } from '@/pages/AdminPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  return role === 'admin' ? <>{children}</> : <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="servers" element={<ServersPage />} />
        <Route path="servers/:id" element={<ServerDetailPage />} />
        <Route path="tenants" element={<TenantsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
        <Route path="credentials" element={<CredentialsPage />} />
        <Route path="admin" element={
          <RequireAdmin>
            <AdminPage />
          </RequireAdmin>
        } />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
