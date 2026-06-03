import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { ScrollText, Loader2, RefreshCw } from 'lucide-react';


interface AuditLog {
  id: string;
  action: string;
  resource: string;
  metadata: string;
  created_at: string;
  user_email: string | null;
}

const actionColor: Record<string, string> = {
  CREATE: 'badge-green',
  UPDATE: 'badge-blue',
  DELETE: 'badge-red',
  LOGIN:  'badge-yellow',
};

export function AuditLogsPage() {
  const { data: logs = [], isLoading: loading, refetch } = useQuery<AuditLog[]>({
    queryKey: ['audit-logs'],
    queryFn: async () => {
      const { data } = await api.get('/mcp/audit-logs?limit=50');
      return data;
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Logs</h1>
          <p className="text-gray-500 text-sm mt-1">Track all actions across your tenant</p>
        </div>
        <button id="refresh-logs" onClick={() => refetch()} disabled={loading} className="btn-secondary">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-600">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading logs…
        </div>
      ) : logs.length === 0 ? (
        <div className="card text-center py-12">
          <ScrollText className="w-12 h-12 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">No audit events recorded yet.</p>
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-5 py-3 text-left font-medium">Action</th>
                  <th className="px-5 py-3 text-left font-medium">Resource</th>
                  <th className="px-5 py-3 text-left font-medium">User</th>
                  <th className="px-5 py-3 text-left font-medium">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-5 py-3">
                      <span className={`badge ${actionColor[log.action] ?? 'badge-blue'}`}>
                        {log.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-300 font-mono text-xs">{log.resource}</td>
                    <td className="px-5 py-3 text-gray-400">{log.user_email ?? 'System'}</td>
                    <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
