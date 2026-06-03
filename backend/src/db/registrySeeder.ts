/**
 * registrySeeder.ts
 *
 * Seeds 5 representative MCP servers into the database on first boot.
 * Idempotent: checks the _seed_flags table before inserting — safe to call
 * on every startup. Each server has a detailed JSON tool schema that describes
 * its callable tools, their parameters, and return types.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from './database';
import { logger } from '../utils/logger';

// ── Tool schema definitions ───────────────────────────────────────────────────

const SEED_SERVERS = [
  {
    name: 'WebSearch MCP',
    base_url: 'https://mcp.websearch.example.com',
    capabilities: ['web_search', 'news_search', 'image_search'],
    tool_schema: {
      tools: [
        {
          name: 'web_search',
          description: 'Search the web and return ranked results with snippets.',
          parameters: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', description: 'The search query string' },
              max_results: { type: 'integer', default: 10, description: 'Max results to return (1–50)' },
              safe_search: { type: 'boolean', default: true },
              language: { type: 'string', default: 'en', description: 'BCP-47 language code' },
            },
          },
          returns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                snippet: { type: 'string' },
                published_date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        {
          name: 'news_search',
          description: 'Search recent news articles from indexed publishers.',
          parameters: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string' },
              from_date: { type: 'string', format: 'date', description: 'Filter articles after this date' },
              sources: { type: 'array', items: { type: 'string' }, description: 'Filter by source domain' },
            },
          },
        },
      ],
      version: '1.2.0',
      auth: 'bearer',
    },
  },
  {
    name: 'FileReader MCP',
    base_url: 'https://mcp.filereader.example.com',
    capabilities: ['file_read', 'file_parse', 'pdf_extract'],
    tool_schema: {
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from a URL or base64-encoded content and return its text.',
          parameters: {
            type: 'object',
            oneOf: [
              { required: ['url'], properties: { url: { type: 'string', format: 'uri' } } },
              { required: ['base64'], properties: { base64: { type: 'string', description: 'Base64-encoded file content' } } },
            ],
            properties: {
              encoding: { type: 'string', default: 'utf-8' },
              max_chars: { type: 'integer', default: 50000 },
            },
          },
          returns: { type: 'object', properties: { content: { type: 'string' }, mime_type: { type: 'string' }, char_count: { type: 'integer' } } },
        },
        {
          name: 'pdf_extract',
          description: 'Extract structured text, tables, and metadata from a PDF document.',
          parameters: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              pages: { type: 'array', items: { type: 'integer' }, description: 'Page numbers to extract (1-indexed). Omit for all pages.' },
              extract_tables: { type: 'boolean', default: true },
            },
          },
        },
      ],
      version: '2.0.1',
      auth: 'bearer',
    },
  },
  {
    name: 'Calculator MCP',
    base_url: 'https://mcp.calculator.example.com',
    capabilities: ['arithmetic', 'statistics', 'unit_conversion', 'expression_eval'],
    tool_schema: {
      tools: [
        {
          name: 'evaluate_expression',
          description: 'Safely evaluate a mathematical expression and return the numeric result.',
          parameters: {
            type: 'object',
            required: ['expression'],
            properties: {
              expression: { type: 'string', description: 'Math expression, e.g. "(2 + 3) * sqrt(16)"' },
              precision: { type: 'integer', default: 10, description: 'Decimal places in result' },
              variables: { type: 'object', additionalProperties: { type: 'number' }, description: 'Named variables to inject' },
            },
          },
          returns: { type: 'object', properties: { result: { type: 'number' }, expression_normalized: { type: 'string' } } },
        },
        {
          name: 'statistics',
          description: 'Compute descriptive statistics for a dataset.',
          parameters: {
            type: 'object',
            required: ['data'],
            properties: {
              data: { type: 'array', items: { type: 'number' } },
              metrics: {
                type: 'array',
                items: { type: 'string', enum: ['mean', 'median', 'mode', 'std_dev', 'variance', 'min', 'max', 'percentiles'] },
                default: ['mean', 'median', 'std_dev'],
              },
            },
          },
        },
        {
          name: 'convert_units',
          description: 'Convert a value between physical units.',
          parameters: {
            type: 'object',
            required: ['value', 'from_unit', 'to_unit'],
            properties: {
              value: { type: 'number' },
              from_unit: { type: 'string', description: 'E.g. "km", "lb", "celsius"' },
              to_unit: { type: 'string' },
            },
          },
        },
      ],
      version: '1.0.0',
      auth: 'api_key',
    },
  },
  {
    name: 'EmailSender MCP',
    base_url: 'https://mcp.emailsender.example.com',
    capabilities: ['send_email', 'send_template', 'schedule_email'],
    tool_schema: {
      tools: [
        {
          name: 'send_email',
          description: 'Send a plain-text or HTML email to one or more recipients.',
          parameters: {
            type: 'object',
            required: ['to', 'subject', 'body'],
            properties: {
              to: { type: 'array', items: { type: 'string', format: 'email' }, description: 'Recipient list' },
              cc: { type: 'array', items: { type: 'string', format: 'email' } },
              bcc: { type: 'array', items: { type: 'string', format: 'email' } },
              subject: { type: 'string', maxLength: 998 },
              body: { type: 'string' },
              html: { type: 'boolean', default: false, description: 'Treat body as HTML' },
              attachments: {
                type: 'array',
                items: { type: 'object', required: ['filename', 'base64'], properties: { filename: { type: 'string' }, base64: { type: 'string' }, mime_type: { type: 'string' } } },
              },
            },
          },
          returns: { type: 'object', properties: { message_id: { type: 'string' }, accepted: { type: 'array', items: { type: 'string' } } } },
        },
        {
          name: 'send_template',
          description: 'Render a named template with variables and send it.',
          parameters: {
            type: 'object',
            required: ['template_id', 'to', 'variables'],
            properties: {
              template_id: { type: 'string' },
              to: { type: 'array', items: { type: 'string', format: 'email' } },
              variables: { type: 'object', additionalProperties: { type: 'string' } },
            },
          },
        },
      ],
      version: '3.1.0',
      auth: 'bearer',
    },
  },
  {
    name: 'ImageGenerator MCP',
    base_url: 'https://mcp.imagegen.example.com',
    capabilities: ['text_to_image', 'image_edit', 'image_describe'],
    tool_schema: {
      tools: [
        {
          name: 'text_to_image',
          description: 'Generate an image from a natural language prompt.',
          parameters: {
            type: 'object',
            required: ['prompt'],
            properties: {
              prompt: { type: 'string', maxLength: 4000, description: 'Description of the image to generate' },
              negative_prompt: { type: 'string', description: 'What to avoid in the generated image' },
              width: { type: 'integer', default: 1024, enum: [512, 768, 1024, 1280, 1536] },
              height: { type: 'integer', default: 1024, enum: [512, 768, 1024, 1280, 1536] },
              steps: { type: 'integer', default: 30, minimum: 10, maximum: 100 },
              style: { type: 'string', enum: ['photorealistic', 'anime', 'oil_painting', 'watercolor', 'sketch'], default: 'photorealistic' },
              seed: { type: 'integer', description: 'Fixed seed for reproducibility' },
            },
          },
          returns: {
            type: 'object',
            properties: {
              image_url: { type: 'string', format: 'uri' },
              image_base64: { type: 'string' },
              seed_used: { type: 'integer' },
            },
          },
        },
        {
          name: 'image_edit',
          description: 'Edit regions of an existing image using a text instruction and an inpainting mask.',
          parameters: {
            type: 'object',
            required: ['image_url', 'instruction'],
            properties: {
              image_url: { type: 'string', format: 'uri' },
              mask_url: { type: 'string', format: 'uri', description: 'White = edit, black = preserve' },
              instruction: { type: 'string' },
            },
          },
        },
        {
          name: 'image_describe',
          description: 'Analyse an image and return a detailed textual description.',
          parameters: {
            type: 'object',
            required: ['image_url'],
            properties: {
              image_url: { type: 'string', format: 'uri' },
              detail_level: { type: 'string', enum: ['brief', 'standard', 'detailed'], default: 'standard' },
            },
          },
          returns: { type: 'object', properties: { description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
        },
      ],
      version: '2.3.0',
      auth: 'bearer',
    },
  },
];

// ── Seeder function ───────────────────────────────────────────────────────────

export function seedRegistry(tenantId: string, ownerUserId: string): void {
  const db = getDatabase();

  // Idempotency check
  const already = db.prepare("SELECT key FROM _seed_flags WHERE key = 'registry_v1'").get();
  if (already) {
    logger.info('ℹ️  Registry seed already applied — skipping');
    return;
  }

  const insert = db.prepare(`
    INSERT INTO mcp_servers
      (id, tenant_id, name, base_url, capabilities, tool_schema, owner_id, is_active)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const seedAll = db.transaction(() => {
    for (const server of SEED_SERVERS) {
      insert.run(
        uuidv4(),
        tenantId,
        server.name,
        server.base_url,
        JSON.stringify(server.capabilities),
        JSON.stringify(server.tool_schema),
        ownerUserId,
      );
    }
    db.prepare("INSERT INTO _seed_flags (key) VALUES ('registry_v1')").run();
  });

  seedAll();
  logger.info(`🌱 Seeded ${SEED_SERVERS.length} MCP servers into registry`);
}
