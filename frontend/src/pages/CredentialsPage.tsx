import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { ShieldCheck, Server, Plus, Trash2, Loader2, X } from 'lucide-react';

interface McpServer {
  id: string;
  name: string;
  base_url: string;
}

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [activeForm, setActiveForm] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');

  const { data: servers = [], isLoading: loadingServers } = useQuery<McpServer[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data } = await api.get('/mcp/servers');
      return data;
    },
  });

  const { data: keys = [], isLoading: loadingKeys } = useQuery<string[]>({
    queryKey: ['vault', 'keys'],
    queryFn: async () => {
      const { data } = await api.get('/vault/keys');
      return data;
    },
  });

  const storeMutation = useMutation({
    mutationFn: async ({ serverId, apiKey }: { serverId: string; apiKey: string }) => {
      await api.post('/vault/store', { server_id: serverId, api_key: apiKey });
    },
    onSuccess: () => {
      toast.success('Credential stored securely');
      setActiveForm(null);
      setApiKeyInput('');
      queryClient.invalidateQueries({ queryKey: ['vault', 'keys'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error ?? 'Failed to store credential');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (serverId: string) => {
      await api.delete(`/vault/${serverId}`);
    },
    onSuccess: () => {
      toast.success('Credential removed');
      queryClient.invalidateQueries({ queryKey: ['vault', 'keys'] });
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error ?? 'Failed to delete credential');
    },
  });

  const handleSave = (serverId: string) => {
    if (!apiKeyInput.trim()) {
      toast.error('API key cannot be empty');
      return;
    }
    storeMutation.mutate({ serverId, apiKey: apiKeyInput.trim() });
  };

  const handleDelete = (serverId: string) => {
    if (confirm('Are you sure you want to delete this credential? Tool calls to this server will fail unless another key is provided.')) {
      deleteMutation.mutate(serverId);
    }
  };

  if (loadingServers || loadingKeys) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-600">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">My Credentials</h1>
        <p className="text-gray-500 text-sm mt-1">Manage API keys for your connected MCP Servers securely.</p>
      </div>

      <div className="grid gap-4">
        {servers.length === 0 ? (
          <div className="card text-center py-12">
            <Server className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500">No MCP servers connected to this tenant yet.</p>
          </div>
        ) : (
          servers.map((server) => {
            const hasKey = keys.includes(server.id);
            const isEditing = activeForm === server.id;

            return (
              <div key={server.id} className="card-hover flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-gray-800 border border-gray-700">
                    <Server className="w-6 h-6 text-gray-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white">{server.name}</h3>
                    <p className="text-sm text-gray-500 font-mono mt-0.5">{server.base_url}</p>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  {hasKey && !isEditing ? (
                    <div className="flex items-center gap-3">
                      <span className="badge badge-green">
                        <ShieldCheck className="w-3 h-3 mr-1" /> Securely Stored
                      </span>
                      <button
                        onClick={() => handleDelete(server.id)}
                        disabled={deleteMutation.isPending}
                        className="btn-danger p-2"
                        title="Remove Credential"
                      >
                        {deleteMutation.isPending && deleteMutation.variables === server.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  ) : isEditing ? (
                    <div className="flex flex-col sm:flex-row items-center gap-2">
                      <input
                        type="password"
                        placeholder="sk-..."
                        className="input sm:w-64"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        autoFocus
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSave(server.id)}
                          disabled={storeMutation.isPending}
                          className="btn-primary"
                        >
                          {storeMutation.isPending && storeMutation.variables?.serverId === server.id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            'Save'
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setActiveForm(null);
                            setApiKeyInput('');
                          }}
                          className="p-2 text-gray-500 hover:text-white transition-colors"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setActiveForm(server.id);
                        setApiKeyInput('');
                      }}
                      className="btn-secondary"
                    >
                      <Plus className="w-4 h-4" /> Add Key
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
