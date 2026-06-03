import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import { Server, Zap, Globe, Loader2, ChevronRight, Search } from 'lucide-react';

interface McpServer {
  id: string;
  name: string;
  base_url: string;
  is_active: number;
  capabilities: string[];
  created_at: string;
}

interface SearchResult {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  score: number;
}

export function DashboardPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Default server query
  const { data: servers, isLoading: isLoadingServers } = useQuery<McpServer[]>({
    queryKey: ['servers'],
    queryFn: async () => {
      const { data } = await api.get('/mcp/servers');
      return data;
    },
  });

  // Debounce logic
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  // Search API call
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    const fetchSearch = async () => {
      setIsSearching(true);
      try {
        const { data } = await api.get(`/mcp/tools/search?q=${encodeURIComponent(debouncedQuery)}`);
        setSearchResults(data);
      } catch (err) {
        console.error('Search failed', err);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    };

    fetchSearch();
  }, [debouncedQuery]);

  return (
    <div className="space-y-8">
      {/* Page header & Search Bar */}
      <div>
        <h1 className="text-2xl font-bold text-white mb-6">
          Good afternoon, {user?.email?.split('@')[0]} 👋
        </h1>
        
        <div className="relative w-full max-w-4xl">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            className="input pl-12 py-4 text-lg bg-gray-900 border-gray-800 focus:border-brand-500 shadow-xl w-full"
            placeholder="Search across all tools by name or description... (e.g. 'read files', 'query database')"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {isSearching && (
            <div className="absolute inset-y-0 right-0 pr-4 flex items-center">
              <Loader2 className="w-5 h-5 text-brand-500 animate-spin" />
            </div>
          )}
        </div>
      </div>

      {/* Render Search Results OR Default Grid */}
      {searchResults !== null ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white mb-2">
            Semantic Search Results ({searchResults.length})
          </h2>
          
          {searchResults.length === 0 ? (
            <div className="card text-center py-12 text-gray-500">
              No semantic matches found for "{debouncedQuery}"
            </div>
          ) : (
            <div className="grid gap-4">
              {searchResults.map((result, i) => {
                // Example score format: 0.145 -> we can display a relative match
                // We'll normalize the max score to roughly 100% just for UI flair
                const maxScore = searchResults[0].score || 1;
                const matchPct = Math.min(99, Math.round((result.score / maxScore) * 100));

                return (
                  <div
                    key={`${result.serverId}-${result.toolName}-${i}`}
                    onClick={() => navigate(`/servers/${result.serverId}?tool=${encodeURIComponent(result.toolName)}`)}
                    className="card-hover group cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between"
                  >
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="font-semibold text-brand-300 text-lg truncate">
                          {result.toolName}
                        </h3>
                        <span className="badge bg-gray-800 text-gray-400 border-gray-700 flex items-center gap-1.5">
                          <Server className="w-3 h-3" /> {result.serverName}
                        </span>
                        <span className="badge bg-emerald-900/30 text-emerald-400 border-emerald-500/20">
                          {matchPct}% Match
                        </span>
                      </div>
                      <p className="text-gray-400 text-sm truncate">{result.description}</p>
                    </div>
                    
                    <div className="mt-4 sm:mt-0 flex-shrink-0 text-brand-400 group-hover:text-brand-300 transition-colors flex items-center text-sm font-medium">
                      Execute <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover:translate-x-1" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white mb-2">Connected MCP Servers</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {isLoadingServers ? (
              <div className="col-span-full flex items-center justify-center py-16 text-gray-600">
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading servers…
              </div>
            ) : servers?.length === 0 ? (
              <div className="col-span-full card text-center py-12">
                <Server className="w-12 h-12 text-gray-700 mx-auto mb-3" />
                <p className="text-gray-500">No MCP servers connected yet.</p>
                <button onClick={() => navigate('/servers')} className="btn-primary mx-auto mt-4">
                  Manage Servers
                </button>
              </div>
            ) : (
              servers?.map((server) => (
                <div
                  key={server.id}
                  onClick={() => navigate(`/servers/${server.id}`)}
                  className="card-hover group cursor-pointer flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-start justify-between mb-4">
                      <div className="p-3 rounded-lg bg-brand-600/10 border border-brand-500/20 text-brand-400">
                        <Server className="w-6 h-6" />
                      </div>
                      <span className={server.is_active ? 'badge badge-green' : 'badge badge-red'}>
                        {server.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    
                    <h3 className="text-lg font-bold text-white mb-1 group-hover:text-brand-400 transition-colors">
                      {server.name}
                    </h3>
                    
                    <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-4">
                      <Globe className="w-3.5 h-3.5" />
                      <span className="font-mono truncate">{server.base_url}</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <Zap className="w-4 h-4 text-amber-500" />
                        <span>{server.capabilities?.length || 0} Capabilities registered</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 flex items-center text-sm font-medium text-brand-400 group-hover:text-brand-300 transition-colors">
                    View Tools <ChevronRight className="w-4 h-4 ml-1 transition-transform group-hover:translate-x-1" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
