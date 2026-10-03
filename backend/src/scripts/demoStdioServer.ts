/**
 * demoStdioServer.ts
 *
 * Standalone MCP server communicating over standard I/O (stdio).
 * Spawned as a child process by McpClientManager for stdio-based downstream servers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({
    name: 'demo-stdio-calculator',
    version: '1.0.0',
  });

  (server as any).registerTool(
    'calc_add',
    {
      description: 'Adds two numbers together',
      inputSchema: {
        a: z.number().describe('First number'),
        b: z.number().describe('Second number'),
      },
    },
    async (args: { a: number; b: number }) => {
      const sum = Number(args.a) + Number(args.b);
      return {
        content: [{ type: 'text', text: `Sum: ${sum}` }],
      };
    },
  );

  (server as any).registerTool(
    'calc_multiply',
    {
      description: 'Multiplies two numbers together',
      inputSchema: {
        a: z.number().describe('First factor'),
        b: z.number().describe('Second factor'),
      },
    },
    async (args: { a: number; b: number }) => {
      const product = Number(args.a) * Number(args.b);
      return {
        content: [{ type: 'text', text: `Product: ${product}` }],
      };
    },
  );

  (server as any).registerTool(
    'get_sys_info',
    {
      description: 'Returns basic system platform information',
      inputSchema: {},
    },
    async () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            platform: process.platform,
            nodeVersion: process.version,
            uptimeSec: Math.round(process.uptime()),
          }),
        }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[demoStdioServer] Fatal error: ${err}\n`);
  process.exit(1);
});
