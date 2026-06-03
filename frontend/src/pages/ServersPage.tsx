import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Server, Plus, Trash2, Loader2, Globe, Zap } from 'lucide-react';

interface McpServer {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  capabilities: string[];
  created_at: string;
}

export function ServersPage() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', capabilities: '' });
  const queryClient = useQueryClient();

  const { data: servers = [], isLoading: loading } = useQuery<McpServer[]>({
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
      toast.success('Server added');
      setShowForm(false);
      setForm({ name: '', base_url: '', api_key: '', capabilities: '' });
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error ?? 'Failed to add server';
      toast.error(msg);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/mcp/servers/${id}`);
    },
    onSuccess: () => {
      toast.success('Server removed');
      queryClient.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: () => toast.error('Failed to delete server')
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    addMutation.mutate({
      name: form.name,
      base_url: form.base_url,
      api_key: form.api_key || undefined,
      capabilities: form.capabilities.split(',').map((c) => c.trim()).filter(Boolean),
    });
  };

  const handleDelete = (id: string) => {
    if (confirm('Delete this server?')) {
      deleteMutation.mutate(id);
    }
  };

  const submitting = addMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">MCP Servers</h1>
          <p className="text-gray-500 text-sm mt-1">Manage connected Model Context Protocol providers</p>
        </div>
        <button id="add-server-btn" onClick={() => setShowForm(!showForm)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add Server
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="card animate-fade-in">
          <h2 className="text-base font-semibold text-white mb-4">Register New MCP Server</h2>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Server Name</label>
              <input className="input" placeholder="My Tool Server" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Base URL</label>
              <input className="input" placeholder="https://tools.example.com" value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })} required />
            </div>
            <div>
              <label className="label">API Key (optional)</label>
              <input className="input" type="password" placeholder="sk-…" value={form.api_key}
                onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
            </div>
            <div>
              <label className="label">Capabilities (comma-separated)</label>
              <input className="input" placeholder="search, code, vision" value={form.capabilities}
                onChange={(e) => setForm({ ...form, capabilities: e.target.value })} />
            </div>
            <div className="sm:col-span-2 flex gap-3 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
              <button id="server-submit" type="submit" disabled={submitting} className="btn-primary">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {submitting ? 'Adding…' : 'Add Server'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-600">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading servers…
        </div>
      ) : servers.length === 0 ? (
        <div className="card text-center py-12">
          <Server className="w-12 h-12 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-500">No MCP servers connected yet.</p>
          <button onClick={() => setShowForm(true)} className="btn-primary mx-auto mt-4">
            <Plus className="w-4 h-4" /> Add your first server
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {servers.map((server) => (
            <div key={server.id} className="card-hover flex items-center gap-4">
              <div className="p-2.5 rounded-lg bg-brand-600/10 border border-brand-500/20 flex-shrink-0">
                <Server className="w-5 h-5 text-brand-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-white truncate">{server.name}</p>
                  <span className={server.is_active ? 'badge badge-green' : 'badge badge-red'}>
                    {server.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-500 mt-0.5">
                  <Globe className="w-3 h-3" />
                  <span className="font-mono truncate">{server.base_url}</span>
                </div>
                {server.capabilities.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <Zap className="w-3 h-3 text-amber-500" />
                    {server.capabilities.map((cap) => (
                      <span key={cap} className="badge badge-yellow text-xs">{cap}</span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => handleDelete(server.id)}
                className="btn-danger p-2 flex-shrink-0"
                title="Remove server"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
