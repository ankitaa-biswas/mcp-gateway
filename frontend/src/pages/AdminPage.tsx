import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';
import { 
  ShieldAlert, Activity, Server, Users, Ban, Plus, Trash2, Loader2, ChevronLeft, ChevronRight, Globe, ScrollText
} from 'lucide-react';
import clsx from 'clsx';

// ── Interfaces ────────────────────────────────────────────────────────────────
interface AdminStats { date: string; allowed: number; blocked: number; }
interface ToolCallLog { id: string; timestamp: string; user_email: string; server_id: string; tool_name: string; was_blocked: boolean; block_reason: string | null; }
interface McpServer { id: string; name: string; base_url: string; is_active: number; capabilities: string[]; }
interface BlocklistEntry { tool_name: string; reason: string; added_by: string; added_at: string; }
interface UserEntry { id: string; email: string; role: string; created_at: string; call_count: number; }

// ── Tab Components ────────────────────────────────────────────────────────────

function AdminDashboardTab() {
  const { data, isLoading } = useQuery<AdminStats[]>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const { data } = await api.get('/admin/stats');
      return data;
    }
  });

  if (isLoading) return <div className="p-8 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;
  if (!data || data.length === 0) return <div className="p-8 text-center text-gray-500 card">No tool call data available for the last 7 days.</div>;

  return (
    <div className="card space-y-4">
      <h2 className="text-lg font-semibold text-white">Tool Calls (Last 7 Days)</h2>
      <div className="h-80 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
            <XAxis dataKey="date" stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} />
            <YAxis stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} allowDecimals={false} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#111827', borderColor: '#374151', color: '#fff' }}
              itemStyle={{ color: '#E5E7EB' }}
            />
            <Legend wrapperStyle={{ paddingTop: '20px' }} />
            <Bar dataKey="allowed" name="Allowed Calls" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={50} />
            <Bar dataKey="blocked" name="Blocked Calls" fill="#EF4444" radius={[4, 4, 0, 0]} maxBarSize={50} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AdminLogsTab() {
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'logs', page],
    queryFn: async () => {
      const { data } = await api.get(`/admin/logs?limit=${limit}&offset=${page * limit}`);
      return data as { data: ToolCallLog[]; pagination: { has_more: boolean; total: number } };
    }
  });

  if (isLoading) return <div className="p-8 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;
  const logs = data?.data || [];

  return (
    <div className="space-y-4">
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-5 py-3 text-left font-medium">Timestamp</th>
                <th className="px-5 py-3 text-left font-medium">User</th>
                <th className="px-5 py-3 text-left font-medium">Tool Name</th>
                <th className="px-5 py-3 text-left font-medium">Status</th>
                <th className="px-5 py-3 text-left font-medium">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {logs.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-gray-500">No logs found.</td></tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-5 py-3 text-gray-400 whitespace-nowrap">{new Date(log.timestamp).toLocaleString()}</td>
                    <td className="px-5 py-3 text-gray-300">{log.user_email || '—'}</td>
                    <td className="px-5 py-3 text-gray-300 font-mono text-xs">{log.tool_name}</td>
                    <td className="px-5 py-3">
                      <span className={log.was_blocked ? 'badge badge-red' : 'badge badge-green'}>
                        {log.was_blocked ? 'Blocked' : 'Allowed'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-400 text-xs truncate max-w-[200px]" title={log.block_reason || ''}>
                      {log.block_reason || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      
      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-500">
          Total logs: {data?.pagination.total || 0}
        </span>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="btn-secondary px-3 py-1.5"
          >
            <ChevronLeft className="w-4 h-4" /> Prev
          </button>
          <span className="text-sm text-gray-400 font-mono">Page {page + 1}</span>
          <button 
            onClick={() => setPage(p => p + 1)}
            disabled={!data?.pagination.has_more}
            className="btn-secondary px-3 py-1.5"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminServersTab() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', capabilities: '' });

  const { data: servers = [], isLoading } = useQuery<McpServer[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data } = await api.get('/mcp/servers');
      return data;
    }
  });

  const addMutation = useMutation({
    mutationFn: async (newServer: any) => {
      const { data } = await api.post('/mcp/servers', newServer);
      return data;
    },
    onSuccess: () => {
      toast.success('Server added successfully');
      setShowForm(false);
      setForm({ name: '', base_url: '', api_key: '', capabilities: '' });
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/mcp/servers/${id}`);
    },
    onSuccess: () => {
      toast.success('Server removed');
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addMutation.mutate({
      name: form.name,
      base_url: form.base_url,
      api_key: form.api_key || undefined,
      capabilities: form.capabilities.split(',').map(c => c.trim()).filter(Boolean),
    });
  };

  if (isLoading) return <div className="p-8 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowForm(!showForm)} className="btn-primary">
          <Plus className="w-4 h-4" /> Add Server
        </button>
      </div>

      {showForm && (
        <div className="card animate-fade-in bg-gray-900 border border-brand-500/20">
          <h3 className="font-semibold text-white mb-4">Add New MCP Server</h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Name</label>
              <input required className="input" placeholder="e.g. Finance Tool" value={form.name} onChange={e => setForm({...form, name: e.target.value})} />
            </div>
            <div>
              <label className="label">Base URL</label>
              <input required className="input" placeholder="https://api.example.com" value={form.base_url} onChange={e => setForm({...form, base_url: e.target.value})} />
            </div>
            <div>
              <label className="label">API Key (Optional)</label>
              <input type="password" className="input" placeholder="sk-..." value={form.api_key} onChange={e => setForm({...form, api_key: e.target.value})} />
            </div>
            <div>
              <label className="label">Capabilities (comma-separated)</label>
              <input className="input" placeholder="search, fetch, execute" value={form.capabilities} onChange={e => setForm({...form, capabilities: e.target.value})} />
            </div>
            <div className="sm:col-span-2 flex justify-end gap-2 mt-2">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={addMutation.isPending} className="btn-primary">
                {addMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="grid gap-3">
        {servers.length === 0 ? (
          <div className="card text-center text-gray-500 py-12">No MCP servers registered.</div>
        ) : (
          servers.map(server => (
            <div key={server.id} className="card-hover flex items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="p-2 rounded-lg bg-gray-800 border border-gray-700">
                  <Server className="w-5 h-5 text-gray-400" />
                </div>
                <div className="truncate">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-white truncate">{server.name}</h3>
                    <span className={server.is_active ? 'badge badge-green' : 'badge badge-red'}>{server.is_active ? 'Active' : 'Inactive'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                    <Globe className="w-3 h-3" />
                    <span className="font-mono">{server.base_url}</span>
                  </div>
                </div>
              </div>
              <button 
                onClick={() => { if(confirm('Delete server?')) deleteMutation.mutate(server.id) }}
                disabled={deleteMutation.isPending}
                className="btn-danger p-2 flex-shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function AdminBlocklistTab() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tool_name: '', reason: '' });

  const { data: blocklist = [], isLoading } = useQuery<BlocklistEntry[]>({
    queryKey: ['admin', 'blocklist'],
    queryFn: async () => {
      const { data } = await api.get('/admin/blocklist');
      return data;
    }
  });

  const addMutation = useMutation({
    mutationFn: async (payload: { tool_name: string; reason: string }) => {
      await api.post('/admin/blocklist', payload);
    },
    onSuccess: () => {
      toast.success('Tool blocked successfully');
      setShowForm(false);
      setForm({ tool_name: '', reason: '' });
      queryClient.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (toolName: string) => {
      await api.delete(`/admin/blocklist/${toolName}`);
    },
    onSuccess: () => {
      toast.success('Tool unblocked');
      queryClient.invalidateQueries({ queryKey: ['admin', 'blocklist'] });
    }
  });

  if (isLoading) return <div className="p-8 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setShowForm(!showForm)} className="btn-primary bg-red-600 hover:bg-red-700 text-white">
          <Ban className="w-4 h-4 mr-2" /> Block New Tool
        </button>
      </div>

      {showForm && (
        <div className="card animate-fade-in bg-gray-900 border border-red-500/20">
          <form onSubmit={e => { e.preventDefault(); addMutation.mutate(form); }} className="flex flex-col sm:flex-row items-end gap-3">
            <div className="flex-1 w-full">
              <label className="label">Tool Name</label>
              <input required className="input" placeholder="e.g. shell_exec" value={form.tool_name} onChange={e => setForm({...form, tool_name: e.target.value})} />
            </div>
            <div className="flex-1 w-full">
              <label className="label">Reason</label>
              <input required className="input" placeholder="e.g. Security risk" value={form.reason} onChange={e => setForm({...form, reason: e.target.value})} />
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
              <button type="submit" disabled={addMutation.isPending} className="btn-primary bg-red-600 hover:bg-red-700 text-white">
                {addMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Block'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wider">
            <tr>
              <th className="px-5 py-3 text-left font-medium">Tool Name</th>
              <th className="px-5 py-3 text-left font-medium">Reason</th>
              <th className="px-5 py-3 text-left font-medium">Added At</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {blocklist.length === 0 ? (
              <tr><td colSpan={4} className="px-5 py-8 text-center text-gray-500">No tools currently blocked.</td></tr>
            ) : (
              blocklist.map((item) => (
                <tr key={item.tool_name} className="hover:bg-gray-800/40">
                  <td className="px-5 py-3 font-mono text-red-400">{item.tool_name}</td>
                  <td className="px-5 py-3 text-gray-300">{item.reason}</td>
                  <td className="px-5 py-3 text-gray-500 text-xs">{new Date(item.added_at).toLocaleDateString()}</td>
                  <td className="px-5 py-3 text-right">
                    <button 
                      onClick={() => { if(confirm('Unblock this tool?')) deleteMutation.mutate(item.tool_name); }}
                      className="text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 p-1.5 rounded-md transition-colors"
                      title="Unblock"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdminUsersTab() {
  const { data: users = [], isLoading } = useQuery<UserEntry[]>({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const { data } = await api.get('/admin/users');
      return data;
    }
  });

  if (isLoading) return <div className="p-8 text-center text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>;

  return (
    <div className="card p-0 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wider">
          <tr>
            <th className="px-5 py-3 text-left font-medium">Email</th>
            <th className="px-5 py-3 text-left font-medium">Role</th>
            <th className="px-5 py-3 text-left font-medium">Joined</th>
            <th className="px-5 py-3 text-right font-medium">Tool Calls</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {users.map((u) => (
            <tr key={u.id} className="hover:bg-gray-800/40">
              <td className="px-5 py-4 text-gray-200 font-medium">{u.email}</td>
              <td className="px-5 py-4">
                <span className={clsx(
                  'badge',
                  u.role === 'admin' ? 'badge-red' : u.role === 'analyst' ? 'badge-blue' : 'badge-green'
                )}>
                  {u.role.toUpperCase()}
                </span>
              </td>
              <td className="px-5 py-4 text-gray-500 text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
              <td className="px-5 py-4 text-right">
                <div className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300 font-mono text-xs">
                  {u.call_count}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page Component ───────────────────────────────────────────────────────

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity },
  { id: 'logs', label: 'Tool Call Logs', icon: ScrollText },
  { id: 'servers', label: 'Manage Servers', icon: Server },
  { id: 'blocklist', label: 'Blocklist', icon: Ban },
  { id: 'users', label: 'Users', icon: Users },
];

export function AdminPage() {
  const [activeTab, setActiveTab] = useState('dashboard');

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
       <div className="flex items-center gap-3">
         <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500">
           <ShieldAlert className="w-6 h-6" />
         </div>
         <div>
           <h1 className="text-2xl font-bold text-white">Admin Panel</h1>
           <p className="text-gray-500 text-sm mt-1">Manage safety policies, monitor usage, and configure gateway settings.</p>
         </div>
       </div>

       <div className="flex space-x-1 border-b border-gray-800 overflow-x-auto no-scrollbar">
         {TABS.map((tab) => (
           <button
             key={tab.id}
             onClick={() => setActiveTab(tab.id)}
             className={clsx(
               'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
               activeTab === tab.id
                 ? 'border-red-500 text-red-400 bg-gray-900/50'
                 : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-900/30'
             )}
           >
             <tab.icon className="w-4 h-4" />
             {tab.label}
           </button>
         ))}
       </div>

       <div className="pt-2">
         {activeTab === 'dashboard' && <AdminDashboardTab />}
         {activeTab === 'logs' && <AdminLogsTab />}
         {activeTab === 'servers' && <AdminServersTab />}
         {activeTab === 'blocklist' && <AdminBlocklistTab />}
         {activeTab === 'users' && <AdminUsersTab />}
       </div>
    </div>
  );
}
