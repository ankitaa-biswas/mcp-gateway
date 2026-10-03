/**
 * demoHttpServer.ts
 *
 * Standalone MCP server communicating over Streamable HTTP transport.
 * Runs on port 8003 (or PORT env) and exposes POST /mcp.
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

const PORT = Number(process.env['DEMO_HTTP_PORT'] ?? 8003);

app.all('/mcp', async (req, res) => {
  // Optional auth validation if Authorization header is provided
  const authHeader = req.headers['authorization'];
  if (authHeader && !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid authorization format' },
      id: null,
    });
    return;
  }

  const server = new McpServer({
    name: 'demo-weather-service',
    version: '1.0.0',
  });

  (server as any).registerTool(
    'get_weather',
    {
      description: 'Returns simulated current weather conditions for a city',
      inputSchema: {
        city: z.string().describe('The name of the city'),
      },
    },
    async (args: { city: string }) => {
      const city = args.city || 'Unknown';
      const conditions = ['Sunny', 'Cloudy', 'Rainy', 'Partly Cloudy', 'Windy'];
      const condition = conditions[Math.abs(city.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % conditions.length];
      const tempC = 15 + (city.length % 15);

      return {
        content: [{
          type: 'text',
          text: `Weather for ${city}: ${condition}, ${tempC}°C (simulated)`,
        }],
      };
    },
  );

  (server as any).registerTool(
    'convert_currency',
    {
      description: 'Converts an amount from one currency to another',
      inputSchema: {
        amount: z.number().describe('Amount to convert'),
        from: z.string().describe('Source currency code, e.g. USD'),
        to: z.string().describe('Target currency code, e.g. EUR'),
      },
    },
    async (args: { amount: number; from: string; to: string }) => {
      const rate = 1.15; // mock rate
      const converted = (Number(args.amount) * rate).toFixed(2);
      return {
        content: [{
          type: 'text',
          text: `${args.amount} ${args.from.toUpperCase()} = ${converted} ${args.to.toUpperCase()}`,
        }],
      };
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Downstream internal error' },
        id: null,
      });
    }
  }
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`🌤️ Demo Streamable HTTP MCP Server listening on http://127.0.0.1:${PORT}/mcp`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
