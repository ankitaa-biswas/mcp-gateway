import natural from 'natural';
import { getDatabase } from '../db/database';
import { logger } from '../utils/logger';

export interface SearchResult {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  score: number;
}

interface ToolDocument {
  tenantId: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
}

let tfidf = new natural.TfIdf();
let documents: ToolDocument[] = [];

export function initializeIndex() {
  try {
    const db = getDatabase();
    const servers = db.prepare('SELECT id, tenant_id, name, tool_schema FROM mcp_servers WHERE is_active = 1').all() as any[];

    tfidf = new natural.TfIdf();
    documents = [];

    for (const server of servers) {
      if (!server.tool_schema) continue;
      
      let schema;
      try {
        schema = JSON.parse(server.tool_schema);
      } catch {
        continue;
      }

      const tools = schema.tools || [];
      for (const tool of tools) {
        const toolName = tool.name || '';
        const description = tool.description || '';
        
        // TF-IDF handles tokenization automatically, we just feed it the combined text
        const docText = `${toolName} ${description}`;
        tfidf.addDocument(docText);
        
        documents.push({
          tenantId: server.tenant_id,
          serverId: server.id,
          serverName: server.name,
          toolName,
          description
        });
      }
    }
    
    logger.info(`🔍 TF-IDF Search Index built with ${documents.length} tools`);
  } catch (error) {
    logger.error('Failed to build search index:', error);
  }
}

export function searchTools(tenantId: string, query: string): SearchResult[] {
  if (!query.trim()) return [];
  
  const results: SearchResult[] = [];
  
  tfidf.tfidfs(query, (i, measure) => {
    // measure is the TF-IDF cosine similarity score
    if (measure > 0 && documents[i].tenantId === tenantId) {
      results.push({
        serverId: documents[i].serverId,
        serverName: documents[i].serverName,
        toolName: documents[i].toolName,
        description: documents[i].description,
        score: measure
      });
    }
  });
  
  // Sort descending by score, take top 20
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}
