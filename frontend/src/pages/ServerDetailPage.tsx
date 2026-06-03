import { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { ArrowLeft, Play, Box, Server, Loader2, Globe, ShieldCheck, AlertTriangle } from 'lucide-react';

import { useAuthStore } from '@/store/authStore';

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface ServerData {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  tool_schema?: { tools?: ToolSchema[] };
}

// Helper Countdown Component
function Countdown({ resetAt, onComplete }: { resetAt: string; onComplete?: () => void }) {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000)));

  useEffect(() => {
    // Initial check
    const initialRemaining = Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
    setSeconds(initialRemaining);
    if (initialRemaining <= 0) {
      onComplete?.();
      return;
    }

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        onComplete?.();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [resetAt, onComplete]);

  return <span>{seconds}s</span>;
}

export function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const targetToolName = searchParams.get('tool');
  const { user } = useAuthStore();
  const isViewer = user?.role === 'viewer';
  
  const [selectedTool, setSelectedTool] = useState<ToolSchema | null>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [result, setResult] = useState<{ output: any; safety: any } | null>(null);
  
  // Overlay state for 429
  const [rateLimitResetAt, setRateLimitResetAt] = useState<string | null>(null);

  const { data: server, isLoading } = useQuery<ServerData>({
    queryKey: ['server', id],
    queryFn: async () => {
      const { data } = await api.get(`/mcp/servers/${id}`);
      return data;
    },
    enabled: !!id,
  });

  // Auto-open modal if tool query param exists
  useEffect(() => {
    if (server && targetToolName && !isViewer) {
      const tool = server.tool_schema?.tools?.find((t) => t.name === targetToolName);
      if (tool && !selectedTool) {
        setSelectedTool(tool);
      }
    }
  }, [server, targetToolName, isViewer]);

  const handleCloseModal = () => {
    setSelectedTool(null);
    if (targetToolName) {
      searchParams.delete('tool');
      setSearchParams(searchParams, { replace: true });
    }
  };

  const callToolMutation = useMutation({
    mutationFn: async ({ tool, params }: { tool: string; params: any }) => {
      const { data } = await api.post(`/proxy/${id}/call`, { tool, params, auth_scheme: 'bearer' });
      return data;
    },
    onSuccess: (data) => {
      setResult({ output: data.result, safety: data.safety });
      toast.success('Tool execution completed');
    },
    onError: (err: any) => {
      if (err.response?.status === 429) {
        const resetAt = err.response.data?.rateLimitInfo?.resetAt;
        if (resetAt) {
          setRateLimitResetAt(resetAt);
        }
      }
      // Toast is already handled globally in api.ts, but we can do it here if we want to bypass global. 
      // The global api interceptor will show the error toast.
    },
  });

  useEffect(() => {
    if (selectedTool?.inputSchema?.properties) {
      const initial: Record<string, any> = {};
      Object.keys(selectedTool.inputSchema.properties).forEach((key) => {
        const prop = selectedTool.inputSchema!.properties![key];
        if (prop.type === 'boolean') initial[key] = false;
        else if (prop.type === 'array') initial[key] = '';
        else if (prop.type === 'object') initial[key] = '';
        else initial[key] = '';
      });
      setFormValues(initial);
      setResult(null);
    } else {
      setFormValues({});
      setResult(null);
    }
  }, [selectedTool]);

  const handleInputChange = (key: string, value: any) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleCallTool = () => {
    if (!selectedTool) return;
    
    const parsedParams: Record<string, any> = {};
    const props = selectedTool.inputSchema?.properties || {};
    
    try {
      for (const [key, prop] of Object.entries(props)) {
        const val = formValues[key];
        if (val === undefined || val === '') continue; 
        
        if (prop.type === 'number') {
          parsedParams[key] = Number(val);
        } else if (prop.type === 'boolean') {
          parsedParams[key] = Boolean(val);
        } else if (prop.type === 'array') {
          parsedParams[key] = typeof val === 'string' ? val.split(',').map(s => s.trim()).filter(Boolean) : val;
        } else if (prop.type === 'object') {
          parsedParams[key] = typeof val === 'string' ? JSON.parse(val) : val;
        } else {
          parsedParams[key] = val;
        }
      }
      
      callToolMutation.mutate({ tool: selectedTool.name, params: parsedParams });
    } catch (e) {
      toast.error('Failed to parse input values. Check your JSON objects or number fields.');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  if (!server) {
    return <div className="text-red-400">Server not found</div>;
  }

  const tools = server.tool_schema?.tools || [];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Rate Limit Full Screen Overlay */}
      {rateLimitResetAt && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gray-950/95 backdrop-blur-xl animate-fade-in p-4 text-center">
          <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-6 border border-red-500/30">
            <AlertTriangle className="w-10 h-10 text-red-500 animate-pulse" />
          </div>
          <h2 className="text-3xl font-bold text-white mb-3">Slow down!</h2>
          <p className="text-xl text-gray-300 mb-6">You've hit the rate limit for tool calls.</p>
          
          <div className="card bg-gray-900 border-gray-800 flex items-center gap-4 text-lg">
            <Loader2 className="w-6 h-6 animate-spin text-brand-400" />
            <span>Resets in <span className="font-mono font-bold text-brand-400"><Countdown resetAt={rateLimitResetAt} onComplete={() => setRateLimitResetAt(null)} /></span></span>
          </div>
        </div>
      )}

      <button onClick={() => navigate('/dashboard')} className="flex items-center text-sm text-gray-400 hover:text-white transition-colors">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
      </button>

      {/* Header */}
      <div className="card flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-4 rounded-xl bg-brand-600/10 border border-brand-500/20 text-brand-400">
            <Server className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              {server.name}
              <span className={server.is_active ? 'badge badge-green' : 'badge badge-red'}>
                {server.is_active ? 'Active' : 'Inactive'}
              </span>
            </h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-gray-400">
              <span className="flex items-center gap-1.5"><Globe className="w-4 h-4" /> {server.base_url}</span>
              <span className="flex items-center gap-1.5"><Box className="w-4 h-4" /> {tools.length} Tools</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tools List */}
      <div>
        <h2 className="text-lg font-semibold text-white mb-4">Available Tools</h2>
        {tools.length === 0 ? (
          <div className="card text-center py-12 text-gray-500">
            No tools exposed by this server's schema.
          </div>
        ) : (
          <div className="grid gap-4">
            {tools.map((tool) => (
              <div key={tool.name} className="card-hover flex items-start justify-between group">
                <div className="flex-1 pr-6">
                  <h3 className="font-semibold text-brand-300 text-lg flex items-center gap-2">
                    {tool.name}
                  </h3>
                  <p className="text-gray-400 text-sm mt-1">{tool.description || 'No description provided'}</p>
                  
                  {tool.inputSchema?.properties && Object.keys(tool.inputSchema.properties).length > 0 && (
                    <div className="mt-4 bg-gray-950 p-3 rounded-lg border border-gray-800">
                      <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Parameters</p>
                      <div className="space-y-2">
                        {Object.entries(tool.inputSchema.properties).map(([key, prop]: [string, any]) => (
                          <div key={key} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3 text-sm text-gray-400">
                            <code className="text-cyan-400 font-mono text-xs">{key}</code>
                            <span className="text-xs text-gray-600 font-mono">{prop.type}</span>
                            <span className="text-gray-300">{prop.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {!isViewer ? (
                  <button
                    onClick={() => setSelectedTool(tool)}
                    className="btn-primary opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Play className="w-4 h-4" /> Call Tool
                  </button>
                ) : (
                  <div className="text-xs text-gray-500 italic opacity-0 group-hover:opacity-100 transition-opacity" title="Viewers cannot execute tools">
                    Read-only mode
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Execution Modal */}
      {selectedTool && !isViewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-950/80 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="p-6 border-b border-gray-800 flex items-center justify-between sticky top-0 bg-gray-900/95 backdrop-blur-md z-10 rounded-t-xl">
              <div>
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <Play className="w-5 h-5 text-brand-400" /> Execute: {selectedTool.name}
                </h3>
                <p className="text-sm text-gray-500 mt-1">{selectedTool.description}</p>
              </div>
              <button onClick={handleCloseModal} className="text-gray-500 hover:text-white">
                ✕
              </button>
            </div>
            
            <div className="p-6 space-y-6 overflow-y-auto">
              {/* Dynamic Form */}
              {selectedTool.inputSchema?.properties && Object.keys(selectedTool.inputSchema.properties).length > 0 ? (
                <div className="space-y-4">
                  {Object.entries(selectedTool.inputSchema.properties).map(([key, prop]: [string, any]) => {
                    const isRequired = selectedTool.inputSchema?.required?.includes(key);
                    
                    return (
                      <div key={key}>
                        <label className="label flex items-center justify-between">
                          <span>{key} {isRequired && <span className="text-red-400">*</span>}</span>
                          <span className="text-xs text-gray-500 font-mono">{prop.type}</span>
                        </label>
                        
                        {prop.type === 'string' && (
                          <input 
                            type="text" 
                            className="input" 
                            value={formValues[key] || ''}
                            onChange={(e) => handleInputChange(key, e.target.value)}
                            placeholder={prop.description}
                          />
                        )}
                        
                        {prop.type === 'number' && (
                          <input 
                            type="number" 
                            className="input" 
                            value={formValues[key] || ''}
                            onChange={(e) => handleInputChange(key, e.target.value)}
                            placeholder={prop.description}
                          />
                        )}
                        
                        {prop.type === 'boolean' && (
                          <div className="flex items-center gap-2 mt-2">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-brand-500 focus:ring-brand-500"
                              checked={!!formValues[key]}
                              onChange={(e) => handleInputChange(key, e.target.checked)}
                            />
                            <span className="text-sm text-gray-300">True / False</span>
                          </div>
                        )}
                        
                        {prop.type === 'array' && (
                          <input 
                            type="text" 
                            className="input" 
                            value={formValues[key] || ''}
                            onChange={(e) => handleInputChange(key, e.target.value)}
                            placeholder="value1, value2, value3..."
                          />
                        )}
                        
                        {prop.type === 'object' && (
                          <textarea 
                            className="input font-mono text-sm h-24"
                            value={formValues[key] || ''}
                            onChange={(e) => handleInputChange(key, e.target.value)}
                            placeholder='{"key": "value"}'
                          />
                        )}
                        
                        {prop.description && (
                          <p className="text-xs text-gray-500 mt-1">{prop.description}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-sm text-gray-500 italic">No input parameters required for this tool.</div>
              )}

              {/* Result View */}
              {result && (
                <div className="animate-fade-in space-y-4">
                  {/* Safety Envelope & Progress Bar */}
                  {result.safety && result.safety.rateLimit && (
                    <div className="p-4 bg-gray-950 border border-gray-800 rounded-lg">
                      <div className="flex items-center gap-3 mb-3">
                        <ShieldCheck className="w-5 h-5 text-brand-400 flex-shrink-0" />
                        <span className="text-sm text-gray-300 font-medium">Security Gate Checked</span>
                      </div>
                      
                      {(() => {
                        const limit = result.safety.rateLimit.limit;
                        const remaining = result.safety.rateLimit.remaining;
                        const resetAt = result.safety.rateLimit.resetAt;
                        const used = limit - remaining;
                        const percentage = (used / limit) * 100;
                        
                        let barColor = 'bg-green-500';
                        if (percentage >= 90) barColor = 'bg-red-500';
                        else if (percentage >= 60) barColor = 'bg-yellow-500';

                        return (
                          <div className="w-full">
                            <div className="flex justify-between text-xs text-gray-400 mb-1.5 font-mono">
                              <span>{used}/{limit} calls used this minute</span>
                              <span>Resets in <Countdown resetAt={resetAt} /></span>
                            </div>
                            <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
                              <div 
                                className={`h-full ${barColor} transition-all duration-700 ease-out`} 
                                style={{ width: `${percentage}%` }} 
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  <div>
                    <label className="label">Result Output</label>
                    <pre className="p-4 bg-gray-950 rounded-lg border border-gray-800 overflow-x-auto text-sm text-emerald-400 font-mono">
                      {JSON.stringify(result.output, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-800 bg-gray-900 sticky bottom-0 flex justify-end gap-3 z-10 rounded-b-xl mt-auto">
              <button onClick={handleCloseModal} className="btn-secondary">
                Close
              </button>
              <button
                onClick={handleCallTool}
                disabled={callToolMutation.isPending}
                className="btn-primary"
              >
                {callToolMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {callToolMutation.isPending ? 'Executing...' : 'Execute Tool'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
