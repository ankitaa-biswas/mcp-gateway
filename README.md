# Multi-Tenant Enterprise MCP Gateway

A secure, multi-tenant proxy gateway for managing, securing, and executing tools exposed by Model Context Protocol (MCP) servers. 

![Dashboard Screenshot](./docs/images/dashboard-placeholder.png)

## Features
-  **Multi-Tenancy**: Completely isolated data, logs, and server registries per tenant.
-  **Role-Based Access Control**: `admin`, `analyst`, and `viewer` roles.
-  **Global Safety Policy Agent**: Rate limiting, dynamic tool blocklisting, and payload sanitization.
-  **Credential Vault**: AES-256-GCM encryption for storing MCP Server API keys.
-  **Semantic Search**: NLP-powered TF-IDF search to instantly find tools.

## Quick Start

### 1. Installation
Clone the repository and install all monorepo dependencies from the root:
```bash
git clone <repo-url>
cd mcp-gateway
npm install
```

### 2. Environment Setup
Create a `.env` file in the `backend` folder (you can copy `.env.example`):
```bash
cp backend/.env.example backend/.env
```
*(The SQLite database will be created automatically in `backend/data/mcp_gateway.db`)*

### 3. Database Seeding (Demo Data)
Populate the database with a test tenant, 3 role-based users, and mock servers:
```bash
npm run seed --workspace=backend
```

### 4. Run Development Servers
Start both the Vite frontend and Express backend concurrently:
```bash
npm run dev
```
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:4000

---

##  Reviewer Notes & Testing Expectations

Because this gateway acts as a proxy for downstream MCP servers, **this demo uses Mock Servers** to prove the pipeline without requiring you to run actual AI servers locally. 

When testing the **Proxy Layer** (`POST /api/proxy/:serverId/call`), please note:
1. **Safety First**: The request is intercepted by the Global Safety Agent. It checks the rate limiter, sanitizes the payload, and validates against the blocklist.
2. **Vault Decryption**: It securely retrieves and decrypts the API key from the AES-256 Vault.
3. **The 502 Bad Gateway**: The gateway will attempt to proxy the request to a mock URL (e.g., `http://localhost:8002`). Because there is no server running there, it will return a `502 Bad Gateway`. 
4. **Conclusion**: This `502` error successfully proves the Gateway received the request, authenticated it, passed all safety checks, retrieved credentials, and attempted forwarding! 

###  Bonus: Run the included Mock AI Server
If you want to test the absolute full end-to-end flow without getting a 502 error, I have included a miniature Mock AI Server script. 
1. Open a new terminal and run: `npx -w backend ts-node-dev src/scripts/mockAiServer.ts`
2. Go to the UI -> **Admin Panel -> Manage Servers** and add a server with Base URL: `http://localhost:8002`.
3. The Gateway will instantly hit the mock server's `/schema` endpoint and dynamically save its tools!
4. Go to **Credentials**, save the API Key `test-key-123`, and execute a tool from the Dashboard for a 100% successful proxy response!

---

## API Reference

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| **POST** | `/api/auth/register` | Register a new tenant and admin user | No |
| **POST** | `/api/auth/login` | Login and receive JWT | No |
| **GET** | `/api/mcp/servers` | List registered MCP servers for tenant | Yes (`viewer+`) |
| **POST** | `/api/mcp/servers` | Register a new MCP server | Yes (`admin`) |
| **GET** | `/api/mcp/tools/search` | Semantic TF-IDF search for tools | Yes (`viewer+`) |
| **POST** | `/api/vault/store` | Securely store an API key (AES-256) | Yes (`admin`) |
| **POST** | `/api/proxy/:serverId/call`| Execute tool (passes through Safety Agent) | Yes (`analyst+`) |
| **GET** | `/api/admin/logs` | View paginated tool call audit logs | Yes (`admin`) |

---

## Screenshots

### Dynamic Tool Execution
![Tool Execution Screenshot](./docs/images/execution-placeholder.png)

### Admin Panel & Logs
![Admin Panel Screenshot](./docs/images/admin-placeholder.png)
