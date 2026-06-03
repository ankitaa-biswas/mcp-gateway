import express from 'express';

const app = express();
app.use(express.json());

const PORT = 8002;

// 1. The /schema endpoint that our Gateway automatically fetches when you add a server via the UI
app.get('/schema', (req, res) => {
  res.json({
    tools: [
      {
        name: 'summarize',
        inputSchema: {
          type: 'object',
          properties: { 
            text: { type: 'string' } 
          },
        },
      },
    ],
  });
});

// 2. The /call endpoint that our Gateway proxy forwards the tool execution to
app.post('/call', (req, res) => {
  
  // Verify the AES-256 decrypted API Key that our Vault injected into the header!
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer test-key-123') {
    console.log('❌ Rejected request: Invalid API Key');
    res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    return;
  }

  const { tool, params } = req.body;
  console.log(`\n✅ Gateway successfully proxied a tool call!`);
  console.log(`Tool: ${tool}`);
  console.log(`Params:`, params);

  if (tool === 'summarize') {
    res.json({
      status: "success",
      result: `Here is the AI generated summary for: "${String(params.text).substring(0, 20)}..."`,
    });
    return;
  }

  res.status(404).json({ error: 'Unknown tool' });
});

app.listen(PORT, () => {
  console.log(`\n🤖 Real(ish) AI Server running on http://localhost:${PORT}`);
  console.log(`\nTo test this end-to-end:`);
  console.log(`1. Go to your Gateway Admin Panel -> Manage Servers`);
  console.log(`2. Add a new server with Base URL: http://localhost:8002`);
  console.log(`   (The Gateway will automatically fetch the schema from /schema)`);
  console.log(`3. Go to Credentials and save the API key: test-key-123`);
  console.log(`4. Go to the Dashboard and execute the 'summarize' tool!`);
});
