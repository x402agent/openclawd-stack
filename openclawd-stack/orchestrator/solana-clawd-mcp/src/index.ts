/**
 * Solana Clawd MCP Server
 * 
 * Model Context Protocol server for Solana trading, research, and agent operations.
 * Integrates with nemoClawd, solana-clawd, and agentwallet-vault.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import nacl from 'tweetnacl';

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC_URL = process.env.HELIUS_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || '';

// Initialize Solana connection
const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

// Wallet keypair (if provided)
let walletKeypair: Keypair | null = null;
if (SOLANA_PRIVATE_KEY) {
  try {
    const decoded = Buffer.from(SOLANA_PRIVATE_KEY, 'base64');
    walletKeypair = Keypair.fromSecretKey(decoded);
    console.error(`[SolanaClawd MCP] Wallet loaded: ${walletKeypair.publicKey.toBase58()}`);
  } catch (e) {
    console.error('[SolanaClawd MCP] Failed to parse SOLANA_PRIVATE_KEY');
  }
}

// MCP Server
const server = new Server(
  {
    name: 'solana-clawd-mcp',
    version: '1.4.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// ============================================
// HELIUS RPC TOOLS
// ============================================

const heliusTools = [
  {
    name: 'helius_account_info',
    description: 'Get account information from Solana blockchain',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Solana account address' },
      },
      required: ['address'],
    },
  },
  {
    name: 'helius_balance',
    description: 'Get SOL balance for an address',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Solana account address' },
      },
      required: ['address'],
    },
  },
  {
    name: 'helius_transactions',
    description: 'Get transaction history for an address',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Solana account address' },
        limit: { type: 'number', description: 'Number of transactions to fetch', default: 10 },
      },
      required: ['address'],
    },
  },
  {
    name: 'helius_priority_fee',
    description: 'Get recommended priority fee',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account address for priority fee' },
      },
      required: ['account'],
    },
  },
];

// ============================================
// SOLANA MARKET TOOLS
// ============================================

const solanaTools = [
  {
    name: 'solana_price',
    description: 'Get price for a Solana token',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Token symbol (e.g., SOL, BONK)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'solana_trending',
    description: 'Get trending Solana tokens',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of tokens to fetch', default: 10 },
      },
    },
  },
  {
    name: 'solana_token_info',
    description: 'Get token metadata',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Token mint address' },
      },
      required: ['address'],
    },
  },
  {
    name: 'solana_wallet_pnl',
    description: 'Calculate wallet P&L',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Wallet address' },
      },
      required: ['address'],
    },
  },
];

// ============================================
// TRADING TOOLS
// ============================================

const tradingTools = [
  {
    name: 'pump_token_scan',
    description: 'Scan new tokens on pump.fun',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of tokens to scan', default: 20 },
      },
    },
  },
  {
    name: 'pump_buy_quote',
    description: 'Get buy quote for a pump.fun token',
    inputSchema: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Token mint address' },
        amount: { type: 'number', description: 'Amount in SOL' },
      },
      required: ['mint', 'amount'],
    },
  },
  {
    name: 'pump_sell_quote',
    description: 'Get sell quote for a pump.fun token',
    inputSchema: {
      type: 'object',
      properties: {
        mint: { type: 'string', description: 'Token mint address' },
        amount: { type: 'number', description: 'Amount of tokens to sell' },
      },
      required: ['mint', 'amount'],
    },
  },
];

// ============================================
// MEMORY TOOLS
// ============================================

const memoryTools = [
  {
    name: 'memory_recall',
    description: 'Query agent memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        tier: { 
          type: 'string', 
          enum: ['KNOWN', 'LEARNED', 'INFERRED'],
          description: 'Memory tier to query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_write',
    description: 'Write to agent memory',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to write' },
        tier: { 
          type: 'string', 
          enum: ['KNOWN', 'LEARNED', 'INFERRED'],
          description: 'Memory tier',
        },
      },
      required: ['content', 'tier'],
    },
  },
];

// ============================================
// WALLET TOOLS
// ============================================

const walletTools = [
  {
    name: 'wallet_balance',
    description: 'Get wallet SOL balance',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wallet_address',
    description: 'Get configured wallet address',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wallet_transfer',
    description: 'Transfer SOL to another address',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address' },
        amount: { type: 'number', description: 'Amount in SOL' },
      },
      required: ['to', 'amount'],
    },
  },
];

// Combine all tools
const allTools = [
  ...heliusTools,
  ...solanaTools,
  ...tradingTools,
  ...memoryTools,
  ...walletTools,
];

// ============================================
// TOOL IMPLEMENTATIONS
// ============================================

async function handleHeliusTool(name: string, args: any) {
  switch (name) {
    case 'helius_account_info': {
      const info = await connection.getAccountInfo(new PublicKey(args.address));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            address: args.address,
            executable: info?.executable || false,
            lamports: info?.lamports.toString() || '0',
            dataSize: info?.data.length || 0,
          }, null, 2),
        }],
      };
    }
    
    case 'helius_balance': {
      const balance = await connection.getBalance(new PublicKey(args.address));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            address: args.address,
            lamports: balance.toString(),
            sol: (balance / 1e9).toFixed(6),
          }, null, 2),
        }],
      };
    }
    
    case 'helius_transactions': {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(args.address),
        { limit: args.limit || 10 }
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ transactions: sigs }, null, 2),
        }],
      };
    }
    
    case 'helius_priority_fee': {
      // Simplified priority fee estimation
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            account: args.account,
            priorityFee: '0.00001', // Simplified
            unitLimit: 1000000,
          }, null, 2),
        }],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleSolanaTool(name: string, args: any) {
  switch (name) {
    case 'solana_price': {
      // Simplified price fetch - would integrate with real API
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            symbol: args.symbol,
            price: 'N/A - integrate with Jupiter/Coingecko',
          }, null, 2),
        }],
      };
    }
    
    case 'solana_trending': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            trending: [],
            message: 'Integrate with Helius trending API',
          }, null, 2),
        }],
      };
    }
    
    case 'solana_token_info': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mint: args.address,
            message: 'Integrate with DAS API',
          }, null, 2),
        }],
      };
    }
    
    case 'solana_wallet_pnl': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            address: args.address,
            pnl: 'N/A - implement with Helius',
          }, null, 2),
        }],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleTradingTool(name: string, args: any) {
  switch (name) {
    case 'pump_token_scan': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            tokens: [],
            message: 'Integrate with pump.fun SDK',
          }, null, 2),
        }],
      };
    }
    
    case 'pump_buy_quote':
    case 'pump_sell_quote': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mint: args.mint,
            amount: args.amount,
            message: 'Integrate with pump.fun SDK',
          }, null, 2),
        }],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMemoryTool(name: string, args: any) {
  switch (name) {
    case 'memory_recall': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query: args.query,
            tier: args.tier || 'ALL',
            results: [],
          }, null, 2),
        }],
      };
    }
    
    case 'memory_write': {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            tier: args.tier,
            contentLength: args.content.length,
          }, null, 2),
        }],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleWalletTool(name: string, args: any) {
  switch (name) {
    case 'wallet_balance': {
      if (!walletKeypair) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'No wallet configured' }, null, 2),
          }],
        };
      }
      const balance = await connection.getBalance(walletKeypair.publicKey);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            address: walletKeypair.publicKey.toBase58(),
            lamports: balance.toString(),
            sol: (balance / 1e9).toFixed(6),
          }, null, 2),
        }],
      };
    }
    
    case 'wallet_address': {
      if (!walletKeypair) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ address: null, error: 'No wallet configured' }, null, 2),
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ address: walletKeypair.publicKey.toBase58() }, null, 2),
        }],
      };
    }
    
    case 'wallet_transfer': {
      if (!walletKeypair) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'No wallet configured' }, null, 2),
          }],
        };
      }
      
      const transaction = new Transaction();
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: walletKeypair.publicKey,
          toPubkey: new PublicKey(args.to),
          lamports: Math.round(args.amount * 1e9),
        })
      );
      
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = walletKeypair.publicKey;
      
      transaction.sign(walletKeypair);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            signature,
            from: walletKeypair.publicKey.toBase58(),
            to: args.to,
            amount: args.amount,
          }, null, 2),
        }],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================
// MCP HANDLERS
// ============================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  
  try {
    // Route to appropriate handler
    let result;
    if (heliusTools.some(t => t.name === name)) {
      result = await handleHeliusTool(name, args);
    } else if (solanaTools.some(t => t.name === name)) {
      result = await handleSolanaTool(name, args);
    } else if (tradingTools.some(t => t.name === name)) {
      result = await handleTradingTool(name, args);
    } else if (memoryTools.some(t => t.name === name)) {
      result = await handleMemoryTool(name, args);
    } else if (walletTools.some(t => t.name === name)) {
      result = await handleWalletTool(name, args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    return result;
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        }, null, 2),
      }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'solana://wallet',
        name: 'Wallet',
        description: 'Configured Solana wallet',
        mimeType: 'application/json',
      },
      {
        uri: 'solana://config',
        name: 'Configuration',
        description: 'MCP server configuration',
        mimeType: 'application/json',
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  
  if (uri === 'solana://wallet') {
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          configured: !!walletKeypair,
          address: walletKeypair?.publicKey.toBase58() || null,
        }, null, 2),
      }],
    };
  }
  
  if (uri === 'solana://config') {
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          heliusRpc: HELIUS_RPC_URL,
          heliusConfigured: !!HELIUS_API_KEY,
          xaiConfigured: !!XAI_API_KEY,
          walletConfigured: !!walletKeypair,
          toolsCount: allTools.length,
        }, null, 2),
      }],
    };
  }
  
  throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'analyze-token',
        description: 'Analyze a Solana token for trading opportunities',
        arguments: [
          {
            name: 'address',
            description: 'Token mint address',
            required: true,
          },
        ],
      },
      {
        name: 'trading-plan',
        description: 'Generate a trading plan based on market conditions',
        arguments: [],
      },
    ],
  };
});

// ============================================
// START SERVER
// ============================================

async function main() {
  console.error('[SolanaClawd MCP] Starting server...');
  console.error(`[SolanaClawd MCP] Connected to: ${HELIUS_RPC_URL}`);
  console.error(`[SolanaClawd MCP] Wallet: ${walletKeypair?.publicKey.toBase58() || 'Not configured'}`);
  console.error(`[SolanaClawd MCP] Tools: ${allTools.length}`);
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('[SolanaClawd MCP] Server ready');
}

main().catch(console.error);
