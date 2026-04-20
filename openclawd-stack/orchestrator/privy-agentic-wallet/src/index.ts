/**
 * Privy Agentic Wallet Integration
 * 
 * Provides wallet authentication and transaction signing for Solana agents
 * using Privy's embedded wallet infrastructure with secure key management.
 */

import {
  PrivyClient,
  WalletClient,
  EmbeddedWalletOLEDConfig,
  SolanaSignTransactionMethods,
} from '@privy-io/node';
import {
  Connection,
  Transaction,
  TransactionInstruction,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { sign } from 'tweetnacl';

// Environment configuration
interface AgenticWalletConfig {
  privyAppId: string;
  privyApiKey: string;
  rpcUrl?: string;
  connection?: Connection;
}

interface WalletAccount {
  address: string;
  publicKey: Buffer;
  createdAt: Date;
  label?: string;
}

interface TransactionRequest {
  instructions: TransactionInstruction[];
  signers?: PublicKey[];
  feePayer?: PublicKey;
  recentBlockhash?: string;
}

/**
 * Privy Agentic Wallet Provider
 * 
 * Manages embedded wallets for autonomous agents with:
 * - Wallet creation and management
 * - Transaction signing via Privy's MPC infrastructure
 * - Balance queries
 * - Transaction history
 */
export class PrivyAgenticWallet {
  private privy: PrivyClient;
  private connection: Connection;
  private wallets: Map<string, WalletAccount> = new Map();
  private isInitialized: boolean = false;

  constructor(config: AgenticWalletConfig) {
    this.connection = config.connection || 
      new Connection(config.rpcUrl || 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY);
    
    this.privy = new PrivyClient({
      appId: config.privyAppId,
      apiKey: config.privyApiKey,
    });
  }

  /**
   * Initialize the wallet provider
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    console.log('[PrivyAgenticWallet] Initializing...');
    console.log('[PrivyAgenticWallet] Connected to:', this.connection.rpcEndpoint);
    
    this.isInitialized = true;
  }

  /**
   * Create a new embedded wallet for an agent
   */
  async createWallet(label?: string): Promise<WalletAccount> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Create embedded wallet via Privy
      const wallet = await this.privy.wallets.create({
        chainType: 'solana',
        config: {
          label: label || `agent-wallet-${Date.now()}`,
        } as EmbeddedWalletOLEDConfig,
      });

      const account: WalletAccount = {
        address: wallet.address,
        publicKey: Buffer.from(wallet.publicKey || []),
        createdAt: new Date(),
        label,
      };

      this.wallets.set(wallet.address, account);
      
      console.log(`[PrivyAgenticWallet] Created wallet: ${wallet.address}`);
      
      return account;
    } catch (error) {
      console.error('[PrivyAgenticWallet] Failed to create wallet:', error);
      throw error;
    }
  }

  /**
   * Get wallet by address
   */
  async getWallet(address: string): Promise<WalletAccount | undefined> {
    return this.wallets.get(address);
  }

  /**
   * List all managed wallets
   */
  listWallets(): WalletAccount[] {
    return Array.from(this.wallets.values());
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<number> {
    try {
      const publicKey = new PublicKey(address);
      const balance = await this.connection.getBalance(publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.error(`[PrivyAgenticWallet] Failed to get balance for ${address}:`, error);
      throw error;
    }
  }

  /**
   * Sign a transaction using Privy's MPC infrastructure
   */
  async signTransaction(
    address: string,
    transaction: Transaction
  ): Promise<Transaction> {
    if (!this.wallets.has(address)) {
      throw new Error(`Wallet ${address} not found`);
    }

    try {
      // Get recent blockhash if not set
      if (!transaction.recentBlockhash) {
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
      }

      // Serialize transaction for signing
      const messageBytes = transaction.serializeMessage();
      
      // Sign using Privy's MPC wallet
      const signature = await this.privy.wallets.signTransaction({
        address,
        chainType: 'solana',
        payload: messageBytes.toString('base64'),
      });

      // Add signature to transaction
      transaction.addSignature(
        this.wallets.get(address)!.publicKey,
        Buffer.from(signature.signature, 'base64')
      );

      return transaction;
    } catch (error) {
      console.error(`[PrivyAgenticWallet] Failed to sign transaction:`, error);
      throw error;
    }
  }

  /**
   * Sign and send a transaction
   */
  async signAndSendTransaction(
    address: string,
    transaction: Transaction
  ): Promise<string> {
    const signedTx = await this.signTransaction(address, transaction);
    const signature = await this.connection.sendRawTransaction(
      signedTx.serialize(),
      { skipPreflight: false, preflightCommitment: 'confirmed' }
    );
    
    console.log(`[PrivyAgenticWallet] Transaction sent: ${signature}`);
    return signature;
  }

  /**
   * Sign multiple transactions
   */
  async signTransactions(
    address: string,
    transactions: Transaction[]
  ): Promise<Transaction[]> {
    return Promise.all(
      transactions.map(tx => this.signTransaction(address, tx))
    );
  }

  /**
   * Confirm a transaction
   */
  async confirmTransaction(signature: string): Promise<boolean> {
    try {
      const result = await this.connection.confirmTransaction(
        signature,
        'confirmed'
      );
      return !result.value.err;
    } catch (error) {
      console.error(`[PrivyAgenticWallet] Failed to confirm transaction:`, error);
      return false;
    }
  }

  /**
   * Create a simple transfer instruction
   */
  createTransferInstruction(
    from: PublicKey,
    to: PublicKey,
    lamports: number
  ): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    });
  }

  /**
   * Get transaction history for a wallet
   */
  async getTransactionHistory(
    address: string,
    limit: number = 10
  ): Promise<any[]> {
    try {
      const publicKey = new PublicKey(address);
      const signatures = await this.connection.getSignaturesForAddress(
        publicKey,
        { limit }
      );
      return signatures;
    } catch (error) {
      console.error(`[PrivyAgenticWallet] Failed to get transaction history:`, error);
      throw error;
    }
  }

  /**
   * Check if a wallet exists on chain
   */
  async walletExists(address: string): Promise<boolean> {
    try {
      const publicKey = new PublicKey(address);
      const accountInfo = await this.connection.getAccountInfo(publicKey);
      return accountInfo !== null;
    } catch {
      return false;
    }
  }
}

/**
 * Agentic Wallet Manager
 * 
 * High-level interface for managing agent wallets with:
 * - Automatic wallet creation
 * - Balance monitoring
 * - Transaction approval workflows
 */
export class AgenticWalletManager {
  private provider: PrivyAgenticWallet;
  private agentId: string;
  private wallets: Map<string, { wallet: WalletAccount; autoSign: boolean }> = new Map();

  constructor(config: AgenticWalletConfig, agentId: string) {
    this.provider = new PrivyAgenticWallet(config);
    this.agentId = agentId;
  }

  async initialize(): Promise<void> {
    await this.provider.initialize();
  }

  /**
   * Register a wallet for an agent
   */
  async registerWallet(
    address: string,
    label?: string,
    autoSign: boolean = false
  ): Promise<WalletAccount> {
    // Create wallet record
    const account = await this.provider.createWallet(label);
    this.wallets.set(account.address, { wallet: account, autoSign });
    
    return account;
  }

  /**
   * Get the default wallet for an agent
   */
  getDefaultWallet(): WalletAccount | undefined {
    const wallets = Array.from(this.wallets.values());
    return wallets.find(w => w.autoSign) || wallets[0]?.wallet;
  }

  /**
   * Execute a transfer with automatic signing
   */
  async executeTransfer(
    to: string,
    lamports: number,
    requireApproval: boolean = true
  ): Promise<{ signature?: string; pending: boolean }> {
    const wallet = this.getDefaultWallet();
    if (!wallet) {
      throw new Error('No default wallet configured');
    }

    const transaction = new Transaction();
    transaction.add(
      this.provider.createTransferInstruction(
        new PublicKey(wallet.address),
        new PublicKey(to),
        lamports
      )
    );

    if (requireApproval) {
      // Return pending transaction for approval
      return { pending: true };
    }

    const signature = await this.provider.signAndSendTransaction(
      wallet.address,
      transaction
    );

    return { signature, pending: false };
  }

  /**
   * Get all wallet balances
   */
  async getAllBalances(): Promise<Map<string, number>> {
    const balances = new Map<string, number>();
    
    for (const [address, { wallet }] of this.wallets) {
      try {
        const balance = await this.provider.getBalance(address);
        balances.set(address, balance);
      } catch {
        balances.set(address, 0);
      }
    }
    
    return balances;
  }
}

/**
 * Factory function to create a Privy Agentic Wallet instance
 */
export async function createPrivyAgenticWallet(
  config: AgenticWalletConfig
): Promise<PrivyAgenticWallet> {
  const wallet = new PrivyAgenticWallet(config);
  await wallet.initialize();
  return wallet;
}

/**
 * Factory function to create an Agentic Wallet Manager
 */
export async function createAgenticWalletManager(
  config: AgenticWalletConfig,
  agentId: string
): Promise<AgenticWalletManager> {
  const manager = new AgenticWalletManager(config, agentId);
  await manager.initialize();
  return manager;
}

// Export types
export type { AgenticWalletConfig, WalletAccount, TransactionRequest };
